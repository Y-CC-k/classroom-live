// 探查：build-and-deploy-menu.ps1 的 New-UpgradeZip
import fs from 'node:fs';

const c = fs.readFileSync('D:/classroom-live/build-and-deploy-menu.ps1', 'utf8');
const i = c.indexOf('function New-UpgradeZip');
if (i < 0) {
  console.log('New-UpgradeZip not found');
  process.exit(0);
}
console.log(c.substring(i, i + 1400));
