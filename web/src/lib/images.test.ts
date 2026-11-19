import { describe, expect, it } from 'vitest';
import { fileIdFor, fitWithin, isAcceptedImage, mimeOf, pickImageFiles, placeImage } from './images';

describe('imagens', () => {
  it('aceita só PNG, JPEG, GIF e WebP', () => {
    expect(isAcceptedImage('image/png')).toBe(true);
    expect(isAcceptedImage('image/webp')).toBe(true);
    expect(isAcceptedImage('image/svg+xml')).toBe(false);
    expect(isAcceptedImage('text/plain')).toBe(false);
  });

  it('separa as imagens de uma lista de arquivos', () => {
    const files = [
      new File(['a'], 'a.png', { type: 'image/png' }),
      new File(['b'], 'b.txt', { type: 'text/plain' }),
      new File(['c'], 'c.jpg', { type: 'image/jpeg' }),
    ];
    expect(pickImageFiles(files).map((f) => f.name)).toEqual(['a.png', 'c.jpg']);
    expect(pickImageFiles(null)).toEqual([]);
  });

  it('lê o tipo de um data URL', () => {
    expect(mimeOf('data:image/webp;base64,AAA')).toBe('image/webp');
    expect(mimeOf('lixo')).toBe('application/octet-stream');
  });

  it('reduz mantendo a proporção e nunca aumenta', () => {
    expect(fitWithin(4000, 3000, 2048)).toEqual({ width: 2048, height: 1536 });
    expect(fitWithin(100, 50, 2048)).toEqual({ width: 100, height: 50 });
  });

  it('entra centrada no ponto, no tamanho natural se couber', () => {
    const r = placeImage({ width: 100, height: 50 }, { x: 400, y: 300 }, { x: 0, y: 0, zoom: 1 }, { width: 800, height: 600 });
    expect(r).toEqual({ minX: 350, minY: 275, maxX: 450, maxY: 325 });
  });

  it('imagem grande ocupa no máximo metade da tela, respeitando o zoom', () => {
    const r = placeImage({ width: 4000, height: 1000 }, { x: 0, y: 0 }, { x: 0, y: 0, zoom: 2 }, { width: 800, height: 600 });
    // Metade da largura da tela = 400 px = 200 unidades com zoom 2.
    expect(r.maxX - r.minX).toBeCloseTo(200);
    expect(r.maxY - r.minY).toBeCloseTo(50);
  });

  it('chave do arquivo vem do conteúdo', async () => {
    const a = await fileIdFor('data:image/png;base64,AAA');
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(await fileIdFor('data:image/png;base64,AAA')).toBe(a);
    expect(await fileIdFor('data:image/png;base64,AAB')).not.toBe(a);
  });
});
