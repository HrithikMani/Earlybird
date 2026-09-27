import { useApi } from '../hooks.js';
import { Card, ErrorBox } from '../components/ui.jsx';
import { RoleTable } from '../components/roles.jsx';

export default function Roles() {
  const { data, error, reload } = useApi('/api/roles?scope=global');
  return (
    <div>
      <h1>Roles</h1>
      <p className="muted">
        Global roles apply to every company. Rules search the portal for each role's search terms, and a job is sent to Discord only if its title
        matches a role (name, search terms or synonyms) and none of its exclude words. Company-specific roles are set on each company's page.
      </p>
      <ErrorBox error={error} />
      <Card title="Global roles" testId="global-roles">
        <RoleTable roles={data?.items || []} scope="global" onChange={reload} />
      </Card>
    </div>
  );
}
