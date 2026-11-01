const fs = require('fs');
const read = (f) => fs.readFileSync(__dirname + '/src/' + f, 'utf8');
let html = read('page.html');
const parts = { '/*STYLE*/': read('style.css'), '/*ENGINE*/': read('engine.js'), '/*BOT*/': read('bot.js'), '/*UI*/': read('ui.js') };
for (const [k, v] of Object.entries(parts)) {
  if (v.includes('</script')) throw new Error(k + ' contains </script');
  html = html.replace(k, () => v);
}
fs.mkdirSync(__dirname + '/docs', { recursive: true });
fs.writeFileSync(__dirname + '/docs/index.html', html);
console.log('built docs/index.html', (html.length / 1024).toFixed(1) + ' KB');
