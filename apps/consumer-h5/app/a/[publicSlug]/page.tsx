import { CustomerServiceShell } from '../../customer-service-shell';
import { loadPublicAssistantSnapshot } from '../../public-api-client';

export const dynamic = 'force-dynamic';

interface PublicAssistantPageProps {
  params: Promise<{ publicSlug: string }>;
}

export default async function PublicAssistantPage({ params }: PublicAssistantPageProps) {
  const { publicSlug } = await params;
  const apiBaseUrl = process.env['NEXT_PUBLIC_PUBLIC_API_BASE_URL'] ?? '/api/v1/public';
  const result = await loadPublicAssistantSnapshot({
    apiBaseUrl,
    origin: process.env['CONSUMER_H5_ORIGIN'] ?? process.env['NEXT_PUBLIC_CONSUMER_H5_ORIGIN'],
    publicSlug,
  });

  return <CustomerServiceShell apiBaseUrl={apiBaseUrl} publicSlug={publicSlug} result={result} />;
}
