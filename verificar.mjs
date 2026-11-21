// Verificador da página de status da Asset Tecnologia. Roda no GitHub Actions a cada 10 minutos
// (.github/workflows/verificar.yml): chama cada serviço de servicos.json, grava o resultado nos
// arquivos de dados e avisa quando um serviço cai.
//
// Uso: node verificar.mjs [pasta-dos-dados]   (padrão: ./dados)
// Sem dependências: Node 20 ou mais novo.
//
// Regras:
// - Um serviço está fora quando não responde 200 em 15 s ou a resposta não traz o texto esperado,
//   duas vezes seguidas, com 10 s de intervalo (uma falha isolada da rede não abre incidente).
// - Incidente abre na primeira verificação fora e fecha na primeira de volta.
// - Aviso: incidente novo termina o job com erro (o GitHub manda e-mail ao dono do repositório) e,
//   se houver HC_URL (Healthchecks.io), cada rodada avisa se está tudo no ar ou não. Assim o
//   Healthchecks também avisa se o próprio verificador parar de rodar.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const PASTA = process.argv[2] ?? "dados";
const TEMPO_LIMITE_MS = 15_000;
const ESPERA_ENTRE_TENTATIVAS_MS = 10_000;
const DIAS_GUARDADOS = 90;
const RECENTES_GUARDADOS = 6 * 24 * 2; // 48 h de verificações de 10 em 10 minutos
const LENTO_MS = 5_000;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const diaSP = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(d);

async function lerJson(arquivo, padrao) {
  try {
    return JSON.parse(await readFile(path.join(PASTA, arquivo), "utf8"));
  } catch {
    return padrao;
  }
}
const gravarJson = (arquivo, dados) => writeFile(path.join(PASTA, arquivo), JSON.stringify(dados, null, 1) + "\n");

async function tentar(s) {
  const inicio = Date.now();
  try {
    const r = await fetch(s.url, { signal: AbortSignal.timeout(TEMPO_LIMITE_MS), redirect: "follow", headers: { "user-agent": "status-asset (verificador de disponibilidade)" } });
    const corpo = await r.text();
    const ms = Date.now() - inicio;
    if (r.status !== 200) return { ok: false, ms, erro: `HTTP ${r.status}` };
    if (s.espera && !corpo.includes(s.espera)) return { ok: false, ms, erro: "resposta sem o conteúdo esperado" };
    return { ok: true, ms };
  } catch (e) {
    const ms = Date.now() - inicio;
    const erro = e?.name === "TimeoutError" ? `sem resposta em ${TEMPO_LIMITE_MS / 1000} s` : `falha de conexão (${e?.cause?.code ?? e?.message ?? "erro"})`;
    return { ok: false, ms, erro };
  }
}

async function verificar(s) {
  const primeira = await tentar(s);
  if (primeira.ok) return primeira;
  await dormir(ESPERA_ENTRE_TENTATIVAS_MS);
  return tentar(s);
}

async function main() {
  await mkdir(PASTA, { recursive: true });
  const config = JSON.parse(await readFile(new URL("./servicos.json", import.meta.url), "utf8"));
  const servicos = config.grupos.flatMap((g) => g.servicos);
  const agora = new Date();
  const hoje = diaSP(agora);

  const resultados = await Promise.all(servicos.map(async (s) => [s.id, await verificar(s)]));

  const estado = await lerJson("estado.json", { servicos: {} });
  const diario = await lerJson("diario.json", { dias: {} });
  const incidentes = await lerJson("incidentes.json", []);
  const recentes = await lerJson("recentes.json", []);

  const novos = [];
  const fora = [];
  for (const [id, r] of resultados) {
    const s = servicos.find((x) => x.id === id);
    const antes = estado.servicos[id] ?? { situacao: "ok", desde: agora.toISOString() };
    const situacao = r.ok ? (r.ms > LENTO_MS ? "lento" : "ok") : "fora";
    const caiu = situacao === "fora";
    const estavaFora = antes.situacao === "fora";
    if (caiu) fora.push(`${s.nome}: ${r.erro}`);
    if (caiu && !estavaFora) {
      incidentes.unshift({ servico: id, nome: s.nome, inicio: agora.toISOString(), fim: null, erro: r.erro });
      novos.push(`${s.nome}: ${r.erro}`);
    }
    if (!caiu && estavaFora) {
      const aberto = incidentes.find((i) => i.servico === id && !i.fim);
      if (aberto) aberto.fim = agora.toISOString();
    }
    estado.servicos[id] = {
      situacao,
      ms: r.ms,
      erro: r.ok ? null : r.erro,
      desde: (situacao === "fora") === estavaFora ? antes.desde : agora.toISOString(),
    };
    const dia = (diario.dias[hoje] ??= {});
    const [ok, total, somaMs] = dia[id] ?? [0, 0, 0];
    dia[id] = [ok + (r.ok ? 1 : 0), total + 1, somaMs + (r.ok ? r.ms : 0)];
  }
  // Serviço tirado de servicos.json sai do estado (o histórico diário fica).
  for (const id of Object.keys(estado.servicos)) if (!servicos.some((s) => s.id === id)) delete estado.servicos[id];
  estado.atualizadoEm = agora.toISOString();
  estado.intervaloMinutos = config.intervaloMinutos;

  const dias = Object.keys(diario.dias).sort();
  for (const d of dias.slice(0, Math.max(0, dias.length - DIAS_GUARDADOS))) delete diario.dias[d];
  const limiteIncidente = new Date(agora.getTime() - DIAS_GUARDADOS * 86_400_000).toISOString();
  const incidentesGuardados = incidentes.filter((i) => !i.fim || i.fim >= limiteIncidente).slice(0, 200);

  recentes.push({ t: agora.toISOString(), r: Object.fromEntries(resultados.map(([id, r]) => [id, r.ok ? r.ms : -1])) });
  const recentesGuardados = recentes.slice(-RECENTES_GUARDADOS);

  await Promise.all([gravarJson("estado.json", estado), gravarJson("diario.json", diario), gravarJson("incidentes.json", incidentesGuardados), gravarJson("recentes.json", recentesGuardados)]);

  for (const [id, r] of resultados) console.log(`${r.ok ? "ok  " : "FORA"} ${id.padEnd(16)} ${String(r.ms).padStart(6)} ms${r.ok ? "" : `  ${r.erro}`}`);

  // Healthchecks.io: sucesso quando tudo está no ar; /fail com a lista quando algo está fora.
  const hc = process.env.HC_URL?.trim();
  if (hc) {
    try {
      await fetch(fora.length ? `${hc}/fail` : hc, { method: "POST", body: fora.length ? fora.join("\n") : "tudo no ar", signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      console.log(`Aviso ao Healthchecks falhou: ${e?.message}`);
    }
  }

  if (novos.length) {
    console.error(`\nServiço fora do ar:\n${novos.join("\n")}`);
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
