import { describe, it, expect, beforeEach } from 'vitest';
import { buildUploadApp } from './upload-api.js';

// Helper to build a multipart request (bypass inject's JSON-only payload)
function multipartRequest(url: string, formData: FormData): Request {
  return new Request(`http://localhost${url}`, {
    method: 'POST',
    body: formData,
  });
}

describe('Upload API', () => {
  let app: ReturnType<typeof buildUploadApp>;

  beforeEach(() => {
    app = buildUploadApp();
  });

  // ─── Single File Upload ───

  it('uploads a single file', async () => {
    const form = new FormData();
    form.append('file', new File(['hello world'], 'test.txt', { type: 'text/plain' }));

    const res = await app.handle(multipartRequest('/upload', form));
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.name).toBe('test.txt');
    expect(body.size).toBe(11); // "hello world" = 11 bytes
    expect(body.type).toBe('text/plain');
    expect(body.id).toBe(1);
  });

  it('rejects upload without file field', async () => {
    const form = new FormData();
    form.append('notfile', 'just text');

    const res = await app.handle(multipartRequest('/upload', form));
    expect(res.status).toBe(400);
  });

  it('rejects non-multipart request to upload', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/upload',
      payload: { file: 'not a file' },
    });
    expect(res.status).toBe(400);
  });

  // ─── List Files ───

  it('lists uploaded files', async () => {
    // Upload two files
    const form1 = new FormData();
    form1.append('file', new File(['aaa'], 'a.txt', { type: 'text/plain' }));
    await app.handle(multipartRequest('/upload', form1));

    const form2 = new FormData();
    form2.append('file', new File(['bbbb'], 'b.txt', { type: 'text/plain' }));
    await app.handle(multipartRequest('/upload', form2));

    const res = await app.inject({ url: '/files' });
    expect(res.status).toBe(200);
    const files = await res.json();
    expect(files).toHaveLength(2);
    expect(files[0].name).toBe('a.txt');
    expect(files[1].name).toBe('b.txt');
  });

  // ─── File with Metadata ───

  it('uploads file with metadata fields', async () => {
    const form = new FormData();
    form.append('file', new File(['data'], 'doc.pdf', { type: 'application/pdf' }));
    form.append('description', 'My document');
    form.append('category', 'reports');

    const res = await app.handle(multipartRequest('/upload-with-metadata', form));
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.name).toBe('doc.pdf');
    expect(body.description).toBe('My document');
    expect(body.category).toBe('reports');
  });

  // ─── Binary Data ───

  it('handles binary file data', async () => {
    const binaryData = new Uint8Array([0x00, 0xFF, 0x42, 0x13, 0x37]);
    const form = new FormData();
    form.append('file', new File([binaryData], 'data.bin', { type: 'application/octet-stream' }));

    const res = await app.handle(multipartRequest('/upload', form));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.size).toBe(5);
    expect(body.type).toBe('application/octet-stream');
  });
});
