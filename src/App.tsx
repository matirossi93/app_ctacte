import { Dashboard } from './components/Dashboard';
import { BotJsonFeed } from './components/BotJsonFeed';

function App() {
  const currentPath = window.location.pathname.toLowerCase();
  const isBotRoute = currentPath.includes('/api/bot');

  if (isBotRoute) {
    return <BotJsonFeed />;
  }

  return (
    <div className="app-container">
      <Dashboard />
    </div>
  );
}

export default App;
