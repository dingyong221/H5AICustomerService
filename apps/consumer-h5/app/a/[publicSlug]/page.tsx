import { CustomerServiceShell } from '../../customer-service-shell';
import { loadPublicAssistantSnapshot } from '../../public-api-client';
import { createServerPublicFetch } from '../../server-public-fetch';

export const dynamic = 'force-dynamic';

interface PublicAssistantPageProps {
  params: Promise<{ publicSlug: string }>;
}

export default async function PublicAssistantPage({ params }: PublicAssistantPageProps) {
  const { publicSlug } = await params;
  const apiBaseUrl = process.env['NEXT_PUBLIC_PUBLIC_API_BASE_URL'] ?? '/api/v1/public';
  const origin = process.env['CONSUMER_H5_ORIGIN'] ?? process.env['NEXT_PUBLIC_CONSUMER_H5_ORIGIN'];
  const result = await loadPublicAssistantSnapshot({
    apiBaseUrl,
    fetchImpl: createServerPublicFetch(origin, process.env['CONSUMER_H5_INTERNAL_API_ORIGIN']),
    origin,
    publicSlug,
  });

  return <CustomerServiceShell apiBaseUrl={apiBaseUrl} publicSlug={publicSlug} result={result} />;
}
