import { CustomerServiceShell } from './customer-service-shell';

export default function ConsumerHomePage() {
  return <CustomerServiceShell result={{ reason: 'not_available', status: 'unavailable' }} />;
}
