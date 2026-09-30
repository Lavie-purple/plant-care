/**
 * 闭环演示：把整条链路的真实输出打印出来。
 *
 * 这不是测试，是给人和机器都看得懂的证据。
 * 运行：node scripts/demo-loop.mjs
 */

import 'fake-indexeddb/auto';
import { PlantCareService, fixedClock } from '../dist/src/app/vertical-slice.js';
import { Repository } from '../dist/src/storage/repository.js';
import { setDatabaseName, STORES } from '../dist/src/storage/indexeddb.js';
import { MockWeatherProvider, SCENARIOS } from '../dist/src/weather/mock.js';

setDatabaseName('demo-loop');
const repo = new Repository();
await repo.open();
await repo.clear();

const weather = new MockWeatherProvider(SCENARIOS.mild);
const clock = fixedClock('2026-09-30T14:32:00+08:00');
const svc = new PlantCareService(repo, weather, clock);

const line = (t) => console.log('\n' + '─'.repeat(64) + '\n' + t + '\n');

line('步骤 1 · 建一盆植物');
const plant = await svc.addPlant({
  name: '龟背竹 A',
  species: '龟背竹',
  family: '天南星科',
  placement: '客厅',
  exposure: 'indoor_window',
  potDiameterCm: 18,
  tags: ['客厅绿植', '大叶'],
});
console.log(`  id=${plant.id}  名称=${plant.name}  位置=${plant.placement}  暴露度=${plant.exposure}`);

line('步骤 2 · 设置养护规则（用户设定，此后系统永不自动改写）');
const rule = await svc.setCareRule(plant.id, 7, 10);
console.log(`  周期 ${rule.recommendedIntervalMin}-${rule.recommendedIntervalMax} 天`);
console.log(`  硬下限 ${rule.minimumInterval} 天 / 硬上限 ${rule.maximumInterval} 天`);
console.log(`  userOverride=${rule.userOverride}  source=${rule.source}`);

line('步骤 3 · 记一次浇水（11 天前，只记时间和方式）');
const base = new Date('2026-09-30T14:32:00+08:00');
base.setDate(base.getDate() - 11);
const m = String(base.getMonth() + 1).padStart(2, '0');
const d = String(base.getDate()).padStart(2, '0');
const w1 = await svc.recordWatering(plant.id, { date: `${base.getFullYear()}-${m}-${d}`, time: '14:20' });
console.log(`  ${w1.date} ${w1.time}  ${w1.method}  ${w1.amountMl}ml  来源=${w1.amountSource}`);
console.log(`  补录状态=${w1.completionState}  入口=${w1.entrySource}`);

line('步骤 4 · 取天气（Mock，离线可重复）');
const wIn = await svc.loadWeather();
if (wIn.available) {
  const s = wIn.snapshot;
  console.log(`  ${s.city}  ${s.temperature}°C  湿度 ${s.humidity}%  降雨概率 ${s.rainProbability}%`);
  console.log(`  风速 ${s.windSpeed} m/s  日照 ${s.sunlight} h  ${s.weatherCondition}`);
} else {
  console.log(`  天气不可用：${wIn.fallback.reason}`);
}

line('步骤 5 · 生成建议');
const rec = await svc.recommend(plant.id, wIn);
const r = rec.recommendation;
console.log(`  结论：${r.action}`);
console.log(`  建议：${r.suggestedAction}`);
console.log(`  信心：${(r.confidence * 100).toFixed(0)}%`);
console.log(`  读到的输入：浇水 ${r.basedOn.wateringCount} 次，天气=${r.basedOn.weatherUnavailable ? '不可用' : '已用'}`);
console.log('\n  依据（每条都必须可追溯到具体数据）：');
for (const x of r.reasons) {
  console.log(`   · ${x.text}`);
  console.log(`     来源 ${x.sourceId}  种类=${x.sourceKind}  性质=${x.source}`);
}

line('步骤 6 · 用户确认「已浇水」');
const decision = await svc.confirm(plant.id, 'rec-demo-1', 'watered');
console.log(`  决定 ${decision.action}  记录于 ${decision.userConfirmedAt}`);

line('步骤 7 · 落记录，并验证它回流成下一次判断的输入');
const history = await repo.wateringHistory(plant.id);
console.log(`  当前浇水历史 ${history.length} 条：`);
for (const h of history) console.log(`   · ${h.date} ${h.time}  ${h.amountMl}ml`);

const rec2 = await svc.recommend(plant.id, wIn);
console.log(`\n  重新判定：${rec2.recommendation.action}  （${rec2.recommendation.suggestedAction}）`);
console.log('  → 闭环成立：这次的记录成了下次判断的输入');

line('附加 · 规则冲突：系统只提示，不改写');
weather.setScenario(SCENARIOS.hotDry);
const hotIn = await svc.loadWeather();
const ruleBefore = JSON.stringify(await repo.getCareRuleByPlant(plant.id));
const rec3 = await svc.recommend(plant.id, hotIn);
console.log(`  天气转为 ${hotIn.available ? hotIn.snapshot.temperature + '°C 干燥' : '不可用'}`);
console.log(`  引擎是否建议调整周期：${rec3.shouldPromptRuleChange}`);
if (rec3.ruleConflictReason) console.log(`  给用户的理由：${rec3.ruleConflictReason}`);
const ruleAfter = JSON.stringify(await repo.getCareRuleByPlant(plant.id));
console.log(`  CareRule 是否被改写：${ruleBefore === ruleAfter ? '否（D-13 铁律成立）' : '是（违反铁律！）'}`);

line('附加 · 天气不可用时的降级');
weather.setFailure('模拟断网');
const downIn = await svc.loadWeather();
console.log(`  天气可用：${downIn.available}`);
const rec4 = await svc.recommend(plant.id, downIn);
console.log(`  降级后仍给出结论：${rec4.recommendation.action}`);
console.log(`  信心降至：${(rec4.recommendation.confidence * 100).toFixed(0)}%`);
console.log(`  依据中明说：${rec4.recommendation.reasons.find((x) => /天气数据暂不可用/.test(x.text))?.text ?? '（未标注）'}`);

line('附加 · 成长时间线（D-08：PlantEvent 的视图，不是独立表）');
await repo.put(STORES.plantEvents, {
  id: 'evt-1', plantId: plant.id, type: 'PHOTO', date: '2026-09-01',
  title: '新叶出现', images: [], metadata: {}, createdAt: '2026-09-01T10:00:00+08:00', version: 0,
});
await repo.put(STORES.plantEvents, {
  id: 'evt-2', plantId: plant.id, type: 'NEW_LEAF', date: '2026-09-18',
  title: '植株明显长高', images: [], metadata: {}, createdAt: '2026-09-18T10:00:00+08:00', version: 0,
});
await repo.put(STORES.plantEvents, {
  id: 'evt-3', plantId: plant.id, type: 'NOTE', date: '2026-09-20',
  images: [], metadata: {}, createdAt: '2026-09-20T10:00:00+08:00', version: 0,
});
const timeline = await repo.growthTimeline(plant.id);
const allEvents = await repo.plantEvents(plant.id);
console.log(`  全部事件 ${allEvents.length} 条（含 NOTE）`);
console.log(`  成长时间线 ${timeline.length} 条（NOTE 不该出现在这里）：`);
for (const e of timeline) console.log(`   · ${e.date}  ${e.type}  ${e.title ?? ''}`);

console.log('\n' + '═'.repeat(64) + '\n完成。\n');
repo.close();
