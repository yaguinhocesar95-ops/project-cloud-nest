# Roadmap — confiabilidade do robô

- [ ] 1. Diagnóstico da rodada: status explícito (rodou, dados válidos, sinal, aceita/bloqueada, falha ≠ sem sinal)
- [ ] 2. Teste de reconexão do preço ao vivo (feed parado → reconecta, retry, recupera)
- [ ] 3. Retenção do cache IndexedDB (limitar/expurgar só cache antigo do app)
- [ ] 4. Medição real de carga (requests, bytes, recomputações) — números atuais são estimativas
- [ ] 5. Probe da nuvem: otimizar só após medir, preservando a checagem de saúde
- [ ] 6. Análise ao abrir a página: visualização leve/cache, adiar análise pesada
- [ ] 7. .env: adiado; confirmar que não contém credenciais privilegiadas
