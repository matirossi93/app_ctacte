import { Dashboard } from './components/Dashboard';
import { BotJsonFeed } from './components/BotJsonFeed';

function App() {
  const isBotRoute = window.location.pathname === '/api/bot';

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
