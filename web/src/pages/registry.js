// Route table for pages beyond Overview/Settings/Logs: [regex, Component].
import Companies from './Companies.jsx';
import CompanyDetail from './CompanyDetail.jsx';
import Roles from './Roles.jsx';
import Jobs from './Jobs.jsx';
import RunDetail from './RunDetail.jsx';
import RulePage from './RulePage.jsx';
import Tasks from './Tasks.jsx';
import TaskDetail from './TaskDetail.jsx';

export const pages = [
  [/^\/companies\/?$/, Companies],
  [/^\/companies\/(?<id>[\w-]+)$/, CompanyDetail],
  [/^\/roles\/?$/, Roles],
  [/^\/jobs\/?$/, Jobs],
  [/^\/runs\/(?<id>[\w-]+)$/, RunDetail],
  [/^\/rules\/(?<id>[\w-]+)$/, RulePage],
  [/^\/tasks\/?$/, Tasks],
  [/^\/tasks\/(?<id>[\w-]+)$/, TaskDetail],
];
