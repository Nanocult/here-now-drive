import { HereNowAPI, SiteInfo } from './HereNowAPI';

export interface PublishOptions {
  driveId: string;
  slug: string;
  version?: string; // Optional: publish specific version
  title?: string;
  description?: string;
}

export class SitesAPI extends HereNowAPI {
  /**
   * Get Site info by slug
   */
  async getSite(slug: string): Promise<SiteInfo> {
    return this.request<SiteInfo>({
      url: `${this.baseUrl}/sites/${slug}`,
      method: 'GET'
    });
  }

  /**
   * Publish a Drive snapshot to a Site
   */
  async publishFromDrive(options: PublishOptions): Promise<SiteInfo> {
    return this.request<SiteInfo>({
      url: `${this.baseUrl}/publish/from-drive`,
      method: 'POST',
      body: JSON.stringify({
        driveId: options.driveId,
        slug: options.slug,
        version: options.version,
        title: options.title,
        description: options.description
      })
    });
  }

  /**
   * Get publish history for a Site
   */
  async getPublishHistory(slug: string, limit: number = 10): Promise<any[]> {
    return this.request({
      url: `${this.baseUrl}/sites/${slug}/publish-history?limit=${limit}`,
      method: 'GET'
    });
  }

  /**
   * Check if a Site slug is available
   */
  async isSlugAvailable(slug: string): Promise<boolean> {
    try {
      await this.getSite(slug);
      return false; // Site exists
    } catch (error: any) {
      if (error.message.includes('404')) {
        return true; // Available
      }
      throw error;
    }
  }
}