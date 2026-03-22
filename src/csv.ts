export function parseCSV(content: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let fields: string[] = [];
  let current = "";
  let inQuotes = false;

  const pushField = () => {
    fields.push(current);
    current = "";
  };

  const pushRow = () => {
    pushField();
    rows.push(fields);
    fields = [];
  };

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < content.length && content[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      pushField();
    } else if (ch === "\r") {
      if (i + 1 < content.length && content[i + 1] === "\n") {
        i++;
      }
      pushRow();
    } else if (ch === "\n") {
      pushRow();
    } else {
      current += ch;
    }
  }

  if (current.length > 0 || fields.length > 0) {
    pushRow();
  }

  return rows;
}

export function parseCSVLine(line: string, delimiter = ","): string[] {
  return parseCSV(line, delimiter)[0] ?? [""];
}
