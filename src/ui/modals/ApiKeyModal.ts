import { App, Modal, Setting, Notice } from 'obsidian';
import HereNowSyncPlugin from '../../main';

export class ApiKeyModal extends Modal {
  private apiKeyInput: HTMLInputElement;
  private testResult: HTMLElement;
  private testButton: HTMLButtonElement;

  constructor(app: App, private plugin: HereNowSyncPlugin) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    
    this.setTitle('Configure here.now API Key');
    
    // Description
    contentEl.createEl('p', {
      text: 'Enter your here.now API key to enable sync. Your key is stored securely in your OS keychain and never synced.'
    });
    
    contentEl.createEl('p').innerHTML = `
      <a href="https://here.now/#api-key" target="_blank">
        Get your API key from here.now dashboard →
      </a>
    `;
    
    // API Key input
    new Setting(contentEl)
      .setName('API Key')
      .addText(text => {
        this.apiKeyInput = text.inputEl;
        text.inputEl.type = 'password';
        text.setPlaceholder('Enter your API key');
      });
    
    // Test connection button
    new Setting(contentEl)
      .setName('Test Connection')
      .setDesc('Verify your API key works before saving')
      .addButton(button => {
        this.testButton = button.buttonEl;
        button
          .setButtonText('Test')
          .onClick(async () => {
            const key = this.apiKeyInput.value.trim();
            if (!key) {
              new Notice('⚠️ Please enter an API key first');
              return;
            }
            
            this.testButton.setText('Testing...');
            this.testButton.setAttribute('disabled', 'true');
            this.testResult.setText('⏳ Connecting...');
            
            // Test directly without saving first
            const result = await this.plugin.authManager.testConnectionWithKey(key);
            
            // Show result
            if (result.success) {
              this.testResult.setText('✅ Connection successful!');
              this.testResult.className = 'test-result success';
              new Notice('✅ API key is valid', 3000);
            } else {
              this.testResult.setText(`❌ ${result.error}`);
              this.testResult.className = 'test-result error';
              new Notice(`❌ ${result.error}`, 5000);
            }
            
            this.testButton.setText('Test');
            this.testButton.removeAttribute('disabled');
          });
      });
    
    // Test result display
    this.testResult = contentEl.createEl('p', { cls: 'test-result' });
    
    // Save button
    new Setting(contentEl)
      .addButton(button => button
        .setButtonText('Save & Close')
        .setCta()
        .onClick(async () => {
          const key = this.apiKeyInput.value.trim();
          if (!key) {
            new Notice('⚠️ API key cannot be empty');
            return;
          }
          
          try {
            await this.plugin.authManager.saveApiKey(key);
            new Notice('✅ API key saved securely');
            this.close();
            
            // Trigger initial sync if this is first setup
            if (!this.plugin.settings.apiKeyLabel || this.plugin.settings.apiKeyLabel.includes('configured')) {
              setTimeout(() => {
                this.plugin.syncEngine.triggerSync({ 
                  source: 'startup', 
                  full: true 
                });
              }, 1000);
            }
          } catch (error: any) {
            new Notice(`❌ Failed to save: ${error.message}`);
          }
        })
      )
      .addButton(button => button
        .setButtonText('Cancel')
        .onClick(() => this.close())
      );
    
    // Load existing key label if available
    if (this.plugin.settings.apiKeyLabel) {
      this.apiKeyInput.placeholder = this.plugin.settings.apiKeyLabel;
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}