# Status da Asset Tecnologia

Página pública de disponibilidade em https://status.assettecnologia.com.br: sistemas Clinalta, Escrituro e Citacerta, vídeo da teleconsulta, atendimento por WhatsApp e os sites.

- `servicos.json`: o que é verificado (endereço e texto esperado na resposta).
- `verificar.mjs`: verificador sem dependências (Node 20). Fora do ar = sem 200 em 15 s ou sem o texto esperado, duas vezes seguidas com 10 s de intervalo.
- `.github/workflows/verificar.yml`: roda a cada 10 minutos no GitHub Actions e publica os dados no ramo `dados` (um commit só, sempre o último estado). Serviço que cai termina o job com erro, e o GitHub avisa por e-mail. Com o segredo `HC_URL` (link de ping do Healthchecks.io), cada rodada também avisa o Healthchecks, que manda e-mail se algo cair ou se o verificador parar de rodar.
- `index.html`: a página (GitHub Pages, domínio em `CNAME`), que lê os dados do ramo `dados`.

Teste local: `node verificar.mjs dados` e abra a pasta num servidor estático (a página lê `dados/` quando está em localhost).

Atenção: o GitHub desliga agendamentos de repositório sem atividade há 60 dias. O verificador publica no ramo `dados` a cada rodada; se o agendamento parar, o Healthchecks avisa (por isso o `HC_URL` é importante).
