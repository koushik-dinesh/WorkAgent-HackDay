// kpi.compute: nightly KPI computation (only with organisation consent and employee notice),
// retention purge and exit deletion (services/kpi).
import { runNightly } from '../../services/kpi/index.js';

export const kpiCompute = { run: async () => runNightly() };
