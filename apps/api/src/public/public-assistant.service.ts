import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import { loadDatabaseConfig, MySqlAssistantLifecycleRepository } from '@h5cs/database';
import type { PublicAssistantSnapshot } from '@h5cs/domain';

type PublicAssistantReader = Pick<MySqlAssistantLifecycleRepository, 'findPublicSnapshot'>;

const publicSlugPattern = /^[a-z0-9][a-z0-9-]{0,62}$/u;

export class PublicAssistantService {
  public constructor(private readonly reader: PublicAssistantReader | null) {}

  public static fromEnvironment(
    environment: NodeJS.ProcessEnv = process.env,
  ): PublicAssistantService {
    if (environment['PUBLIC_CONVERSATION_ENABLED'] !== 'true') {
      return new PublicAssistantService(null);
    }
    const database = loadDatabaseConfig(environment);
    return new PublicAssistantService(
      database.configured ? new MySqlAssistantLifecycleRepository(database.config) : null,
    );
  }

  public async load(publicSlug: string): Promise<{
    publicAssistantId: string;
    merchantDisplayName: string;
    assistantDisplayName: string;
    aiDisclosure: true;
    businessScope: string;
    welcomeMessage: string;
    availability: 'online';
    releaseRef: string;
  }> {
    if (!publicSlugPattern.test(publicSlug)) throw new NotFoundException('Assistant not available');
    if (this.reader === null) throw new ServiceUnavailableException('Public assistant unavailable');
    let snapshot: PublicAssistantSnapshot | null;
    try {
      snapshot = await this.reader.findPublicSnapshot(publicSlug);
    } catch {
      throw new ServiceUnavailableException('Public assistant unavailable');
    }
    if (snapshot === null) throw new NotFoundException('Assistant not available');
    return {
      publicAssistantId: snapshot.publicAssistantId,
      merchantDisplayName: snapshot.merchantName,
      assistantDisplayName: snapshot.assistantName,
      aiDisclosure: true,
      businessScope: snapshot.businessScope,
      welcomeMessage: snapshot.welcomeMessage,
      availability: 'online',
      releaseRef: snapshot.releaseRef,
    };
  }
}
