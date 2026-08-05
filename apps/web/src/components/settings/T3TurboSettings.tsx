import { FileTextIcon, GaugeIcon } from "lucide-react";

import { type MarkdownPreviewMode, useMarkdownPreviewMode } from "~/markdownPreviewPreference";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const MARKDOWN_PREVIEW_MODE_LABELS: Readonly<Record<MarkdownPreviewMode, string>> = {
  pretty: "Pretty",
  code: "Code",
};

export function T3TurboSettingsPanel() {
  const [markdownPreviewMode, setMarkdownPreviewMode] = useMarkdownPreviewMode();

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="t3-turbo-settings"
        title="T3 Turbo Settings"
        icon={<GaugeIcon className="size-4.5 text-muted-foreground" />}
      >
        <SettingsRow
          {...searchableSetting("markdown-file-preview")}
          description="Choose whether Markdown files open as a formatted document or editable source code in the file side panel."
          control={
            <Select
              value={markdownPreviewMode}
              onValueChange={(value) => {
                if (value === "pretty" || value === "code") {
                  setMarkdownPreviewMode(value);
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Markdown file display">
                <FileTextIcon className="size-3.5 text-muted-foreground" />
                <SelectValue>{MARKDOWN_PREVIEW_MODE_LABELS[markdownPreviewMode]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="pretty">
                  Pretty
                </SelectItem>
                <SelectItem hideIndicator value="code">
                  Code
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
