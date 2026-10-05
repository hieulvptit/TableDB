import { AppShell } from '../AppShell';
import { DesktopRoutes } from './routes';

export default function DesktopApp() {
  return <AppShell router="hash"><DesktopRoutes /></AppShell>;
}
