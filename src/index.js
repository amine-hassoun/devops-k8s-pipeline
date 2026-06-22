const express = require('express');
const app = express();
app.use(express.json());

const items = [];

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/items', (req, res) => res.json(items));
app.post('/items', (req, res) => {
  const item = req.body;
  items.push(item);
  res.status(201).json(item);
});

const PORT = process.env.PORT || 3000;
if (require.main === module) app.listen(PORT, () => console.log(`Running on ${PORT}`));
module.exports = app;
