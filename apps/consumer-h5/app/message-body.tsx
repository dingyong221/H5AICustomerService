import type { ReactNode } from 'react';

type TextBlock =
  | { kind: 'paragraph'; content: string }
  | { kind: 'unordered'; items: string[] }
  | { kind: 'ordered'; items: { content: string; value: number }[] };

/** Flat lists and paragraphs only. Indented/nested syntax remains ordinary text. */
function textBlocks(content: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  for (const line of content.replace(/\r\n?/gu, '\n').split('\n')) {
    const previous = blocks.at(-1);
    if (line.trim() === '') {
      // A separator prevents the next line from joining the previous block.
      if (previous?.kind !== 'paragraph' || previous.content !== '')
        blocks.push({ kind: 'paragraph', content: '' });
      continue;
    }
    const unordered = /^[-+*] +(.+)$/u.exec(line);
    const ordered = /^([1-9]\d{0,3})[.)] +(.+)$/u.exec(line);
    if (unordered) {
      if (previous?.kind === 'unordered') previous.items.push(unordered[1]!);
      else blocks.push({ kind: 'unordered', items: [unordered[1]!] });
    } else if (ordered) {
      const item = { content: ordered[2]!, value: Number(ordered[1]) };
      if (previous?.kind === 'ordered') previous.items.push(item);
      else blocks.push({ kind: 'ordered', items: [item] });
    } else if (previous?.kind === 'paragraph' && previous.content !== '') {
      previous.content += `\n${line}`;
    } else {
      blocks.push({ kind: 'paragraph', content: line });
    }
  }
  return blocks.filter((block) => block.kind !== 'paragraph' || block.content !== '');
}

/** No HTML, URLs, link syntax, recursive markdown or raw-HTML rendering. */
function emphasis(content: string): ReactNode {
  // Markup-looking lines stay wholly literal, including their ** characters.
  // This also keeps link labels/destinations visible rather than implying a trusted action.
  if (/[<>\[\]`]|https?:\/\/|javascript:|data:/iu.test(content)) return content;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of content.matchAll(/(?<!\*)\*\*([^*\n]+)\*\*(?!\*)/gu)) {
    const value = match[1]!;
    if (value.trim() !== value) continue;
    parts.push(content.slice(cursor, match.index));
    parts.push(<strong key={match.index}>{value}</strong>);
    cursor = match.index + match[0].length;
  }
  parts.push(content.slice(cursor));
  return parts;
}

export function MessageBody({ content, role }: { content: string; role: 'assistant' | 'visitor' }) {
  // Consumer text never acquires the formatting or presentation of a business answer.
  if (role === 'visitor') return <p className="message-plain">{content}</p>;
  return (
    <div className="message-body">
      {textBlocks(content).map((block, index) => {
        if (block.kind === 'paragraph') return <p key={index}>{emphasis(block.content)}</p>;
        if (block.kind === 'unordered')
          return (
            <ul key={index}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{emphasis(item)}</li>
              ))}
            </ul>
          );
        return (
          <ol key={index} start={block.items[0]!.value}>
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex} value={item.value}>
                {emphasis(item.content)}
              </li>
            ))}
          </ol>
        );
      })}
    </div>
  );
}
