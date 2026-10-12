import { execFileSync } from 'node:child_process'

const suites = ['models', 'drag', 'panel', 'toast', 'store', 'taskflow', 'components', 'bundle']
let total = 0

for (const suite of suites) {
  const out = execFileSync(process.execPath, ['test/' + suite + '.test.mjs'], { encoding: 'utf8' })
  const matched = out.match(/全部 (\d+) 项通过/)
  const count = matched ? Number(matched[1]) : 0
  total += count
  console.log(suite.padEnd(11) + String(count).padStart(4) + ' 项  OK')
}

console.log('---')
console.log('TOTAL ' + total)
