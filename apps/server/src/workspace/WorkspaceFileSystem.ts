// @effect-diagnostics nodeBuiltinImport:off
/**
 * WorkspaceFileSystem - Effect service contract for workspace file mutations.
 *
 * Owns workspace-root-relative file read/write operations and their associated
 * safety checks and cache invalidation hooks.
 *
 * @module WorkspaceFileSystem
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";

import type {
  ProjectDeleteFileInput,
  ProjectDeleteFileResult,
  ProjectDuplicateFileInput,
  ProjectDuplicateFileResult,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectRenameFileInput,
  ProjectRenameFileResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const PROJECT_READ_FILE_MAX_BYTES = 1024 * 1024;

export class WorkspaceFileSystemOperationError extends Schema.TaggedErrorClass<WorkspaceFileSystemOperationError>()(
  "WorkspaceFileSystemOperationError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    operationPath: Schema.String,
    operation: Schema.Literals([
      "realpath-workspace-root",
      "realpath-target",
      "open",
      "stat",
      "read",
      "close",
      "make-directory",
      "write-file",
      "realpath-destination-parent",
      "lstat",
      "link",
      "rollback-unlink",
      "copy-file",
      "unlink",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Workspace file operation '${this.operation}' failed at '${this.operationPath}' for resolved path '${this.resolvedPath}' (requested as '${this.relativePath}' in '${this.workspaceRoot}').`;
  }
}

export class WorkspaceFilePathEscapeError extends Schema.TaggedErrorClass<WorkspaceFilePathEscapeError>()(
  "WorkspaceFilePathEscapeError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedWorkspaceRoot: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' resolves outside workspace root '${this.workspaceRoot}': ${this.resolvedPath}`;
  }
}

export class WorkspacePathNotFileError extends Schema.TaggedErrorClass<WorkspacePathNotFileError>()(
  "WorkspacePathNotFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace path '${this.relativePath}' in '${this.workspaceRoot}' is not a file: ${this.resolvedPath}`;
  }
}

export class WorkspaceBinaryFileError extends Schema.TaggedErrorClass<WorkspaceBinaryFileError>()(
  "WorkspaceBinaryFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' in '${this.workspaceRoot}' is binary and cannot be previewed as text.`;
  }
}

export class WorkspaceFileAlreadyExistsError extends Schema.TaggedErrorClass<WorkspaceFileAlreadyExistsError>()(
  "WorkspaceFileAlreadyExistsError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file destination '${this.relativePath}' already exists in '${this.workspaceRoot}'.`;
  }
}

export const WorkspaceFileSystemError = Schema.Union([
  WorkspaceFileSystemOperationError,
  WorkspaceFilePathEscapeError,
  WorkspacePathNotFileError,
  WorkspaceBinaryFileError,
  WorkspaceFileAlreadyExistsError,
]);
export type WorkspaceFileSystemError = typeof WorkspaceFileSystemError.Type;

/** Service tag for workspace file operations. */
export class WorkspaceFileSystem extends Context.Service<
  WorkspaceFileSystem,
  {
    /** Read a UTF-8 text file relative to the workspace root. */
    readonly readFile: (
      input: ProjectReadFileInput,
    ) => Effect.Effect<
      ProjectReadFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /**
     * Write a file relative to the workspace root.
     *
     * Creates parent directories as needed and rejects paths that escape the
     * workspace root.
     */
    readonly writeFile: (
      input: ProjectWriteFileInput,
    ) => Effect.Effect<
      ProjectWriteFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    readonly renameFile: (
      input: ProjectRenameFileInput,
    ) => Effect.Effect<
      ProjectRenameFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    readonly duplicateFile: (
      input: ProjectDuplicateFileInput,
    ) => Effect.Effect<
      ProjectDuplicateFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    readonly deleteFile: (
      input: ProjectDeleteFileInput,
    ) => Effect.Effect<
      ProjectDeleteFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
  }
>()("t3/workspace/WorkspaceFileSystem") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;

  const isPathOutsideRoot = (root: string, target: string): boolean => {
    const relativePath = path.relative(root, target);
    return (
      relativePath.startsWith(`..${path.sep}`) ||
      relativePath === ".." ||
      path.isAbsolute(relativePath)
    );
  };

  const resolveRealWorkspaceRoot = Effect.fn("WorkspaceFileSystem.resolveRealWorkspaceRoot")(
    function* (workspaceRoot: string, relativePath: string, resolvedPath: string) {
      return yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(workspaceRoot),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot,
            relativePath,
            resolvedPath,
            operationPath: workspaceRoot,
            operation: "realpath-workspace-root",
            cause,
          }),
      });
    },
  );

  const resolveExistingFile = Effect.fn("WorkspaceFileSystem.resolveExistingFile")(function* (
    input: ProjectReadFileInput,
  ) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    const realWorkspaceRoot = yield* resolveRealWorkspaceRoot(
      input.cwd,
      input.relativePath,
      target.absolutePath,
    );
    const realTargetPath = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(target.absolutePath),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: target.absolutePath,
          operation: "realpath-target",
          cause,
        }),
    });
    if (isPathOutsideRoot(realWorkspaceRoot, realTargetPath)) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: realTargetPath,
      });
    }
    const stat = yield* Effect.tryPromise({
      try: () => NodeFSP.lstat(target.absolutePath),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: realTargetPath,
          operationPath: target.absolutePath,
          operation: "lstat",
          cause,
        }),
    });
    if (!stat.isFile()) {
      return yield* new WorkspacePathNotFileError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath: realTargetPath,
      });
    }
    return { target, realWorkspaceRoot, realTargetPath };
  });

  const resolveDestination = Effect.fn("WorkspaceFileSystem.resolveDestination")(function* (
    workspaceRoot: string,
    relativePath: string,
    realWorkspaceRoot: string,
  ) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot,
      relativePath,
    });
    const destinationParent = path.dirname(target.absolutePath);
    const realDestinationParent = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(destinationParent),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot,
          relativePath,
          resolvedPath: target.absolutePath,
          operationPath: destinationParent,
          operation: "realpath-destination-parent",
          cause,
        }),
    });
    const realDestinationPath = path.join(
      realDestinationParent,
      path.basename(target.absolutePath),
    );
    if (isPathOutsideRoot(realWorkspaceRoot, realDestinationPath)) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot,
        relativePath,
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: realDestinationPath,
      });
    }
    return { target, realDestinationPath };
  });

  const readFile: WorkspaceFileSystem["Service"]["readFile"] = Effect.fn(
    "WorkspaceFileSystem.readFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    const realWorkspaceRoot = yield* resolveRealWorkspaceRoot(
      input.cwd,
      input.relativePath,
      target.absolutePath,
    );
    const realTargetPath = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(target.absolutePath),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: target.absolutePath,
          operation: "realpath-target",
          cause,
        }),
    });
    if (isPathOutsideRoot(realWorkspaceRoot, realTargetPath)) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: realTargetPath,
      });
    }

    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => NodeFSP.open(realTargetPath, "r"),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: realTargetPath,
            operationPath: realTargetPath,
            operation: "open",
            cause,
          }),
      }),
      (handle) =>
        Effect.gen(function* () {
          const stat = yield* Effect.tryPromise({
            try: () => handle.stat(),
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: realTargetPath,
                operation: "stat",
                cause,
              }),
          });
          if (!stat.isFile()) {
            return yield* new WorkspacePathNotFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }

          const bytesToRead = Math.min(stat.size, PROJECT_READ_FILE_MAX_BYTES);
          const buffer = Buffer.alloc(bytesToRead);
          const { bytesRead } = yield* Effect.tryPromise({
            try: () => handle.read(buffer, 0, bytesToRead, 0),
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: realTargetPath,
                operation: "read",
                cause,
              }),
          });
          const fileBytes = buffer.subarray(0, bytesRead);
          if (fileBytes.includes(0)) {
            return yield* new WorkspaceBinaryFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }

          return {
            relativePath: target.relativePath,
            contents: new TextDecoder("utf-8").decode(fileBytes),
            byteLength: stat.size,
            truncated: stat.size > PROJECT_READ_FILE_MAX_BYTES,
          };
        }),
      (handle) =>
        Effect.tryPromise({
          try: () => handle.close(),
          catch: (cause) =>
            new WorkspaceFileSystemOperationError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
              operationPath: realTargetPath,
              operation: "close",
              cause,
            }),
        }),
    );
  });

  const writeFile: WorkspaceFileSystem["Service"]["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: target.absolutePath,
            operationPath: path.dirname(target.absolutePath),
            operation: "make-directory",
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFileString(target.absolutePath, input.contents).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: target.absolutePath,
            operationPath: target.absolutePath,
            operation: "write-file",
            cause,
          }),
      ),
    );
    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: target.relativePath };
  });

  const renameFile: WorkspaceFileSystem["Service"]["renameFile"] = Effect.fn(
    "WorkspaceFileSystem.renameFile",
  )(function* (input) {
    const source = yield* resolveExistingFile(input);
    const destination = yield* resolveDestination(
      input.cwd,
      input.destinationRelativePath,
      source.realWorkspaceRoot,
    );
    yield* Effect.tryPromise({
      try: () => NodeFSP.link(source.target.absolutePath, destination.target.absolutePath),
      catch: (cause) =>
        (cause as NodeJS.ErrnoException).code === "EEXIST"
          ? new WorkspaceFileAlreadyExistsError({
              workspaceRoot: input.cwd,
              relativePath: destination.target.relativePath,
              resolvedPath: destination.realDestinationPath,
            })
          : new WorkspaceFileSystemOperationError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: destination.realDestinationPath,
              operationPath: destination.target.absolutePath,
              operation: "link",
              cause,
            }),
    });

    const unlinkSourceResult = yield* Effect.tryPromise({
      try: () => NodeFSP.unlink(source.target.absolutePath),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: source.realTargetPath,
          operationPath: source.target.absolutePath,
          operation: "unlink",
          cause,
        }),
    }).pipe(Effect.result);
    if (unlinkSourceResult._tag === "Failure") {
      const rollbackResult = yield* Effect.tryPromise({
        try: () => NodeFSP.unlink(destination.target.absolutePath),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: destination.realDestinationPath,
            operationPath: destination.target.absolutePath,
            operation: "rollback-unlink",
            cause: new AggregateError(
              [unlinkSourceResult.failure.cause, cause],
              "Failed to unlink the rename source and roll back its destination link.",
            ),
          }),
      }).pipe(Effect.result);
      if (rollbackResult._tag === "Failure") {
        return yield* rollbackResult.failure;
      }
      return yield* unlinkSourceResult.failure;
    }

    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: destination.target.relativePath };
  });

  const duplicateFile: WorkspaceFileSystem["Service"]["duplicateFile"] = Effect.fn(
    "WorkspaceFileSystem.duplicateFile",
  )(function* (input) {
    const source = yield* resolveExistingFile(input);
    const extension = path.extname(source.target.absolutePath);
    const basename = path.basename(source.target.absolutePath, extension);
    const directory = path.dirname(source.target.absolutePath);
    const duplicateCandidate = (copyNumber: number): string => {
      const copySuffix = copyNumber === 1 ? " copy" : ` copy ${copyNumber}`;
      return path.join(directory, `${basename}${copySuffix}${extension}`);
    };
    const firstCandidate = duplicateCandidate(1);
    yield* resolveDestination(
      input.cwd,
      path.relative(input.cwd, firstCandidate),
      source.realWorkspaceRoot,
    );
    let copyOperationPath = firstCandidate;
    const copiedAbsolutePath = yield* Effect.tryPromise({
      try: async () => {
        for (let copyNumber = 1; ; copyNumber += 1) {
          const candidate = duplicateCandidate(copyNumber);
          copyOperationPath = candidate;
          try {
            await NodeFSP.copyFile(
              source.target.absolutePath,
              candidate,
              NodeFS.constants.COPYFILE_EXCL,
            );
            return candidate;
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "EEXIST") continue;
            throw cause;
          }
        }
      },
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: copyOperationPath,
          operationPath: copyOperationPath,
          operation: "copy-file",
          cause,
        }),
    });
    const relativePath = path.relative(input.cwd, copiedAbsolutePath).replaceAll("\\", "/");
    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath };
  });

  const deleteFile: WorkspaceFileSystem["Service"]["deleteFile"] = Effect.fn(
    "WorkspaceFileSystem.deleteFile",
  )(function* (input) {
    const source = yield* resolveExistingFile(input);
    yield* Effect.tryPromise({
      try: () => NodeFSP.unlink(source.target.absolutePath),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: source.realTargetPath,
          operationPath: source.target.absolutePath,
          operation: "unlink",
          cause,
        }),
    });
    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: source.target.relativePath };
  });

  return WorkspaceFileSystem.of({ deleteFile, duplicateFile, readFile, renameFile, writeFile });
});

export const layer = Layer.effect(WorkspaceFileSystem, make);
