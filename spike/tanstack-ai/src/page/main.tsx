// The spike page's entry: the store over the Worker's SSE route, and the page.
import { fetchServerSentEvents } from '@tanstack/ai-client';
import { createRoot } from 'react-dom/client';
import { ChatPage } from './chat';
import { chatStore } from './store';

const store = chatStore(fetchServerSentEvents('/api/chat'), crypto.randomUUID());
const root = document.getElementById('root');
if (root) createRoot(root).render(<ChatPage store={store} />);
