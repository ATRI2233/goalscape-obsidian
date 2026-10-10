// src/views/promptModal.ts
// 轻量输入 / 确认弹窗，供右键菜单 / 信息面板共用，避免重复定义。

import { App, Modal, Setting } from "obsidian";

export function promptInput(app: App, title: string, initial: string): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = new PromptModal(app, title, initial, resolve);
    modal.open();
  });
}

/** 删除等不可逆操作用它拿确认；按 ESC 关闭等同于取消。 */
export function confirmAction(app: App, message: string, okText = "Delete"): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const modal = new ConfirmModal(app, message, okText, settle, () => settle(false));
    modal.open();
  });
}

class ConfirmModal extends Modal {
  constructor(
    app: App,
    private message: string,
    private okText: string,
    private onAnswer: (ok: boolean) => void,
    private onCancel: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", { text: this.message });
    // 必须先答后关：Modal.close() 会同步触发 onClose，先关就会走到"取消"分支
    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText(this.okText).setCta().onClick(() => {
          this.onAnswer(true);
          this.close();
        })
      )
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => {
          this.onAnswer(false);
          this.close();
        })
      );
  }

  onClose(): void {
    this.onCancel();
    this.contentEl.empty();
  }
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
