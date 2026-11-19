// Decodifica o caminho achatado que vem do núcleo (ver `RenderPath::to_flat` no Rust):
// [modo, op, args..., op, args...], modo 0 = contorno, 1 = preenchido, 2 = texto, 3 = imagem (sem comandos);
// op 0 = moveTo(x, y), 1 = lineTo(x, y), 2 = bezierCurveTo(6 números), 3 = closePath.

export type PaintMode = 'stroke' | 'fill' | 'text' | 'image';

/** O pedaço de `Path2D`/`CanvasRenderingContext2D` que usamos: facilita testar sem navegador. */
export interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void;
  closePath(): void;
}

export function decodePath(data: ArrayLike<number>, sink: PathSink): PaintMode {
  const at = (i: number): number => {
    const v = data[i];
    if (v === undefined) throw new Error(`caminho truncado na posição ${i}`);
    return v;
  };
  const head = at(0);
  const mode: PaintMode = head === 3 ? 'image' : head === 2 ? 'text' : head === 1 ? 'fill' : 'stroke';
  let i = 1;
  while (i < data.length) {
    const op = at(i);
    switch (op) {
      case 0:
        sink.moveTo(at(i + 1), at(i + 2));
        i += 3;
        break;
      case 1:
        sink.lineTo(at(i + 1), at(i + 2));
        i += 3;
        break;
      case 2:
        sink.bezierCurveTo(at(i + 1), at(i + 2), at(i + 3), at(i + 4), at(i + 5), at(i + 6));
        i += 7;
        break;
      case 3:
        sink.closePath();
        i += 1;
        break;
      default:
        throw new Error(`comando de caminho desconhecido: ${op}`);
    }
  }
  return mode;
}
