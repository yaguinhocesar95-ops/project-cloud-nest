# Roadmap — confiabilidade do robô

- [x] 1. Diagnóstico da rodada
- [x] 2. Teste de reconexão do preço ao vivo
- [x] 3. Retenção do cache IndexedDB
- [x] 4. Medição real de carga (navegador medido; nuvem sem rodadas registradas)
- [x] 5. Probe da nuvem: completa a cada 5 min, leve (BTC/SOL) nos outros
- [x] 6. Análise ao abrir a página adiada para quando a página fica ociosa
- [x] 7. .env conferido
- [ ] 8. Agendador da nuvem (a cada minuto) não está configurado neste backend novo — aguarda decisão do usuário

## Correções (instrução "Analise e corrija")
- [ ] C1 Cancelamento atômico do ciclo
- [ ] C2 Preferência do robô no 1º carregamento
- [ ] C3 Timeout cobrindo o corpo JSON
- [ ] C4 Contagem real de dados válidos
- [ ] C5 Cancelamento/status da nuvem
- [ ] C6 WebSocket backoff + aba oculta
- [ ] C7 Migrations seguras
- [ ] C8 Docs/lint
