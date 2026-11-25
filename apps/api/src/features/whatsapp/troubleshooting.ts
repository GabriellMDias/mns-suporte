import { Type } from "typebox";

const guidance = {
  printer_offline_v1: {
    symptom:
      /\b(impressora\s+(est[aá]\s+)?(offline|desconectada|fora de linha)|impressora\s+n[aã]o\s+(imprime|responde))\b/u,
    instructions:
      "*Impressora indisponível*\nConfira se a impressora está ligada e se o painel mostra falta de papel ou alguma mensagem de erro. Se estiver tudo em ordem, envie uma única impressão de teste pelo aplicativo habitual.",
  },
  network_one_device_v1: {
    symptom:
      /\b(sem internet|sem conex[aã]o|wi-?fi (caiu|n[aã]o conecta)|internet (caiu|n[aã]o funciona))\b/u,
    instructions:
      "*Conexão indisponível*\nConfira se o aparelho mostra que está conectado à rede corporativa. Se puder, verifique se outro aparelho da mesma unidade também apresenta o problema e informe isso no chamado.",
  },
} as const;

export type GuidanceId = keyof typeof guidance;
const guideIds = Object.keys(guidance) as GuidanceId[];
export const guidanceIdSchema = Type.Union([
  Type.Literal("printer_offline_v1"),
  Type.Literal("network_one_device_v1"),
]);

export function selectGuidance(
  description: string | undefined,
): GuidanceId | undefined {
  if (!description) return undefined;
  const normalized = description.toLowerCase().normalize("NFC");
  const matches = guideIds.filter((id) =>
    guidance[id].symptom.test(normalized),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function guidanceInstructions(id: GuidanceId): string {
  return guidance[id].instructions;
}
