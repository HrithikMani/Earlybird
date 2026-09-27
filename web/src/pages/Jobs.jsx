import { Card } from '../components/ui.jsx';
import { JobsTable } from '../components/jobs.jsx';

export default function Jobs() {
  return (
    <div>
      <h1>Jobs</h1>
      <Card>
        <JobsTable />
      </Card>
    </div>
  );
}
