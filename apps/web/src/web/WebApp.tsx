import { AppShell } from '../AppShell';
import { WebRoutes } from './routes';

export default function WebApp() {
  return <AppShell router="browser"><WebRoutes /></AppShell>;
}
