import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Repository } from '../storage/repository.js';
import { OpenMeteoProvider } from '../weather/open-meteo.js';
import { PlantCareService, systemClock } from '../app/vertical-slice.js';
import { App } from './App.js';
import './tokens.css';

const repo = new Repository();
void repo.open().then(async () => {
  // 首次运行没有任何数据时，灌入两盆示例，让界面不是空的。
  // 这些是明确标注的示例数据，不是「看起来像真实数据」的假数据。
  if ((await repo.allPlants()).length === 0) {
    const svc = new PlantCareService(repo, new OpenMeteoProvider(), systemClock());
    const a = await svc.addPlant({
      name: '龟背竹 A',
      species: '龟背竹',
      family: '天南星科',
      placement: '客厅',
      exposure: 'indoor_window',
      potDiameterCm: 18,
      tags: ['客厅绿植', '大叶'],
    });
    await svc.setCareRule(a.id, 7, 10);
    const b = await svc.addPlant({
      name: '薄荷',
      species: '薄荷',
      family: '唇形科',
      placement: '阳台',
      exposure: 'outdoor',
      potDiameterCm: 14,
      tags: ['可食用'],
    });
    await svc.setCareRule(b.id, 3, 5);
  }

  const service = new PlantCareService(repo, new OpenMeteoProvider(), systemClock());
  const root = document.getElementById('root');
  if (!root) throw new Error('缺少 #root 挂载点');
  createRoot(root).render(
    <StrictMode>
      <App service={service} />
    </StrictMode>,
  );
});
