import { Suspense, lazy } from 'react';

const loadChatMarkdown = () => import('../ChatMarkdown');
const ChatMarkdown = lazy(loadChatMarkdown);

/** Fetch the Markdown chunk ahead of the first reply. */
export const prefetchMarkdown = (): Promise<void> => loadChatMarkdown().then(() => undefined);

/* A reply rendered as Markdown. Until its chunk arrives the text shows as
   written, in the same place, so nothing jumps. */
export default function MarkdownReply({ text }: { text: string }) {
  return (
    <Suspense fallback={<p className="glass-markdown-pending">{text}</p>}>
      <ChatMarkdown text={text} />
    </Suspense>
  );
}
