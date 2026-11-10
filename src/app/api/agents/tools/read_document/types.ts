export type DocumentKind =
  | 'pdf'
  | 'presentation'
  | 'spreadsheet'
  | 'document'
  | 'csv'
  | 'text';

export type DocumentSection = {
  id: string;
  title?: string;
  text?: string;
  tables?: Array<{ rows: unknown[][] }>;
  metadata?: Record<string, unknown>;
};

export type DocumentImage = {
  page: number;
  mime_type: 'image/png';
  data_url: string;
};

export type DocumentReadResult = {
  success: true;
  type: DocumentKind;
  filename: string;
  mime_type: string;
  metadata: Record<string, unknown>;
  sections: DocumentSection[];
  truncated: boolean;
  warnings: string[];
  /** Complete encoded images, bounded separately from the text JSON budget. */
  images?: DocumentImage[];
};

export type DocumentReadOptions = {
  pages?: number[];
  slides?: number[];
  sheets?: string[];
  maxSections?: number;
  maxChars?: number;
};

export type LoadedDocument = {
  buffer: Buffer;
  filename: string;
  mimeType: string;
};