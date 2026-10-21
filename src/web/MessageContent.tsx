import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Render the stored answer; never transform or replace scientific values. */
export function MessageContent({ content }: { content: string }) {
  return <div className="message-markdown">
    <Markdown remarkPlugins={[remarkGfm]} components={{
      table: ({ node: _node, ...props }) => <div className="message-table"><table {...props} /></div>,
      a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
    }}>{content}</Markdown>
  </div>
}
