import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/* The chat's Markdown, in its own chunk: react-markdown, remark-gfm and
   micromark are the largest separable part of the workspace bundle, and
   nothing needs them before the first reply renders. */
export default function ChatMarkdown({ text }: { text: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        table: ({ children }) => (
          <div className="glass-table-scroll" role="region" aria-label="Table, scroll horizontally if needed" tabIndex={0}>
            <table>{children}</table>
          </div>
        ),
      }}
    >
      {text}
    </Markdown>
  );
}
