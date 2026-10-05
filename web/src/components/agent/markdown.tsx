'use client'

import ReactMarkdown from 'react-markdown'

export function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-sp text-[15.5px] leading-[1.75] text-[#202124] break-words">
      <ReactMarkdown
        components={{
          p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
          h1: ({ children }) => <h1 className="text-xl font-bold mt-4 mb-2 text-[#1a1c20]">{children}</h1>,
          h2: ({ children }) => <h2 className="text-lg font-bold mt-4 mb-2 text-[#1a1c20]">{children}</h2>,
          h3: ({ children }) => <h3 className="text-base font-semibold mt-3 mb-1.5 text-[#1a1c20]">{children}</h3>,
          ul: ({ children }) => <ul className="list-disc pl-5 mb-3 space-y-1.5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 mb-3 space-y-1.5">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          strong: ({ children }) => <strong className="font-semibold text-[#1a1c20]">{children}</strong>,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer" className="text-[#315CEA] hover:underline">
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-[3px] border-[#315CEA]/40 bg-[#F5F7FF] rounded-r-lg py-2 px-4 my-3 text-[#3c4658]">
              {children}
            </blockquote>
          ),
          code: ({ className, children }) => {
            const isBlock = /language-/.test(className || '')
            if (isBlock) {
              return <code className={`${className} block bg-[#F6F8FA] rounded-xl p-4 text-[13px] font-mono overflow-x-auto sp-scroll border border-[#EBEDF0]`}>{children}</code>
            }
            return <code className="bg-[#F0F3F8] text-[#2a3a6e] rounded-md px-1.5 py-0.5 text-[13.5px] font-mono">{children}</code>
          },
          pre: ({ children }) => <pre className="my-3">{children}</pre>,
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto sp-scroll rounded-xl border border-[#EBEDF0]">
              <table className="w-full text-sm border-collapse">{children}</table>
            </div>
          ),
          th: ({ children }) => <th className="bg-[#F7F8FA] font-semibold text-left px-3 py-2 border-b border-[#EBEDF0]">{children}</th>,
          td: ({ children }) => <td className="px-3 py-2 border-b border-[#EBEDF0] align-top">{children}</td>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
