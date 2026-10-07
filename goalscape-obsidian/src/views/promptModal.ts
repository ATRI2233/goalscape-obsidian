// src/views/promptModal.ts
// 轻量输入弹窗，供右键菜单 / 信息面板共用，避免重复定义。

import { App, Modal, Setting } from "obsidian";

export function promptInput(app: App, title: string, initial: string): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = new PromptModal(app, title, initial, resolve);
    modal.open();
  });
}

class PromptModal extends Modal {
  private value: string;

  constructor(
    app: App,
    private titleText: string,
    private initial: string,
    private onSubmit: (value: string | null) => void
  ) {
    super(app);
    this.value = initial;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: this.titleText });

    new Setting(contentEl).setName("Value").addText((text) => {
      text.setValue(this.initial);
      text.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.close();
          this.onSubmit(this.value);
        }
      });
      text.onChange((v) => (this.value = v));
    });

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("Confirm").onClick(() => {
          this.close();
          this.onSubmit(this.value);
        })
      )
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => {
          this.close();
          this.onSubmit(null);
        })
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
