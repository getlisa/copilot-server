export class ContextRepository {
  private notImplemented<T>(): Promise<T> {
    return Promise.reject(new Error("Context repository not implemented"));
  }

  async create(..._args: any[]): Promise<any> {
    return this.notImplemented();
  }
  async getById(..._args: any[]): Promise<any> {
    return this.notImplemented();
  }
  async getByConversationId(..._args: any[]): Promise<any[]> {
    return this.notImplemented();
  }
  async getByType(..._args: any[]): Promise<any[]> {
    return this.notImplemented();
  }
  async getLatestByType(..._args: any[]): Promise<any> {
    return this.notImplemented();
  }
  async updateContent(..._args: any[]): Promise<any> {
    return this.notImplemented();
  }
  async updateEmbedding(..._args: any[]): Promise<any> {
    return this.notImplemented();
  }
  async delete(..._args: any[]): Promise<void> {
    return this.notImplemented();
  }
  async deleteByConversationId(..._args: any[]): Promise<void> {
    return this.notImplemented();
  }
  async deleteExpired(..._args: any[]): Promise<number> {
    return this.notImplemented();
  }
  async upsertByType(..._args: any[]): Promise<any> {
    return this.notImplemented();
  }
  async getTotalTokenCount(..._args: any[]): Promise<number> {
    return this.notImplemented();
  }
  async storeJobSnapshot(..._args: any[]): Promise<any> {
    return this.notImplemented();
  }
  async storeSummary(..._args: any[]): Promise<any> {
    return this.notImplemented();
  }
  async storeMemory(..._args: any[]): Promise<any> {
    return this.notImplemented();
  }
}

export const contextRepository = new ContextRepository();

