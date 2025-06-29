
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3004;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// Database configuration
console.log('🔧 Инициализация базы данных...');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 10
});

pool.on('error', (err) => {
  console.error('❌ Ошибка пула БД:', err.message);
});

// Initialize database
async function initDatabase() {
  let client;
  try {
    client = await pool.connect();

    // Создаем таблицу users если она не существует
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGINT PRIMARY KEY,
        first_name VARCHAR(255) NOT NULL,
        last_name VARCHAR(255),
        username VARCHAR(255),
        language_code VARCHAR(10) DEFAULT 'en',
        balance INTEGER DEFAULT 10,
        cards TEXT DEFAULT '[]',
        is_premium BOOLEAN DEFAULT false,
        photo_url TEXT,
        allows_write_to_pm BOOLEAN DEFAULT false,
        winner INTEGER DEFAULT 0,
        games INTEGER DEFAULT 0,
        loses INTEGER DEFAULT 0,
        last_activity VARCHAR(20),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Добавляем новые столбцы если они не существуют
    await client.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS winner INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS games INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS loses INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS last_activity VARCHAR(20),
      ADD COLUMN IF NOT EXISTS ban INTEGER DEFAULT NULL
    `);

    // Создаем таблицу admin если она не существует
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin (
        maintenance INTEGER DEFAULT 0,
        whitelist TEXT DEFAULT ''
      )
    `);

    // Вставляем начальную запись для админки если её нет
    const adminCheck = await client.query('SELECT maintenance FROM admin LIMIT 1');
    if (adminCheck.rows.length === 0) {
      await client.query('INSERT INTO admin (maintenance, whitelist) VALUES (0, \'\')');
    }

    // Создаем таблицу спонсоров
    await client.query(`
      CREATE TABLE IF NOT EXISTS sponsors (
        position INTEGER PRIMARY KEY CHECK (position IN (1, 2, 3)),
        name VARCHAR(255) NOT NULL,
        url_channel TEXT NOT NULL,
        photo_url TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Создаем индекс для быстрого поиска по позиции
    await client.query('CREATE INDEX IF NOT EXISTS idx_sponsors_position ON sponsors(position)');

    // Создаем таблицу игр
    await client.query(`
      CREATE TABLE IF NOT EXISTS game (
        id SERIAL PRIMARY KEY,
        room_code VARCHAR(4) UNIQUE NOT NULL,
        player1 BIGINT NOT NULL,
        player2 BIGINT,
        game_state VARCHAR(20) DEFAULT 'waiting',
        sender_hod INTEGER DEFAULT 0,
        protect_hod INTEGER DEFAULT 0,
        zone_sender INTEGER,
        zone_protect1 INTEGER,
        zone_protect2 INTEGER,
        bet INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Создаем индексы для таблицы игр
    await client.query('CREATE INDEX IF NOT EXISTS idx_game_room_code ON game(room_code)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_game_player1 ON game(player1)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_game_player2 ON game(player2)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_game_state ON game(game_state)');

    console.log('✅ База данных инициализирована с таблицами users и game');
    console.log('✅ Поля users: id, first_name, last_name, username, language_code, balance, cards, is_premium, photo_url, allows_write_to_pm, winner, games, loses, last_activity');
    console.log('✅ Поля game: id, room_code, player1, player2, game_state, sender_hod, protect_hod, zone_sender, zone_protect1, zone_protect2, bet');
  } catch (err) {
    console.error('❌ Ошибка инициализации БД:', err.message);
  } finally {
    if (client) client.release();
  }
}

// Функция для логирования
function logRequest(req, message) {
  const timestamp = new Date().toISOString();
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const userAgent = req.get('User-Agent') || 'unknown';
  console.log(`[${timestamp}] ${message} | IP: ${ip} | UserAgent: ${userAgent}`);
}

// Routes
app.get('/api/test', (req, res) => {
  logRequest(req, '🔍 Проверка сервера');
  res.json({ 
    status: 'success', 
    message: 'Сервер работает!', 
    timestamp: new Date().toISOString(),
    port: PORT,
    environment: process.env.NODE_ENV || 'development'
  });
});

app.get('/api/test-db', async (req, res) => {
  logRequest(req, '🔍 Проверка БД');
  let client;
  try {
    client = await pool.connect();
    const result = await client.query('SELECT NOW() as current_time, version() as db_version');

    res.json({ 
      status: 'success', 
      message: 'База данных подключена!', 
      current_time: result.rows[0].current_time,
      db_version: result.rows[0].db_version
    });
  } catch (err) {
    console.error('❌ Ошибка БД:', err.message);
    res.status(500).json({ 
      status: 'error', 
      message: 'Ошибка подключения к базе данных', 
      error: err.message,
      code: err.code
    });
  } finally {
    if (client) client.release();
  }
});

// ===== USERS API =====

// Поиск пользователя по ID или username
app.get('/api/user/search', async (req, res) => {
  const { id, username } = req.query;
  logRequest(req, `🔍 Поиск пользователя: ID=${id}, username=${username}`);

  if (!id && !username) {
    return res.status(400).json({ 
      status: 'error', 
      message: 'Требуется ID или username для поиска' 
    });
  }

  let client;
  try {
    client = await pool.connect();
    let result;

    if (id) {
      result = await client.query('SELECT * FROM users WHERE id = $1', [id]);
    } else {
      result = await client.query('SELECT * FROM users WHERE username = $1', [username]);
    }

    if (result.rows.length > 0) {
      const user = result.rows[0];
      console.log(`✅ Пользователь найден при поиске: ${user.first_name} (ID: ${user.id})`);
      res.json({ 
        status: 'success', 
        user: user
      });
    } else {
      console.log(`ℹ️ Пользователь не найден при поиске: ID=${id}, username=${username}`);
      res.json({ 
        status: 'success', 
        user: null,
        message: 'Пользователь не найден'
      });
    }
  } catch (err) {
    console.error(`❌ Ошибка поиска пользователя:`, err.message);
    res.status(500).json({ 
      status: 'error', 
      message: 'Ошибка поиска пользователя', 
      error: err.message
    });
  } finally {
    if (client) client.release();
  }
});

// Получить пользователя по ID
app.get('/api/user/:id', async (req, res) => {
  const userId = req.params.id;
  logRequest(req, `🔍 Поиск пользователя ID: ${userId}`);

  let client;
  try {
    client = await pool.connect();
    const result = await client.query('SELECT * FROM users WHERE id = $1', [userId]);

    if (result.rows.length > 0) {
      // Обновляем last_activity
      const now = new Date();
      const lastActivity = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;

      await client.query(
        'UPDATE users SET last_activity = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [lastActivity, userId]
      );

      const user = { ...result.rows[0], last_activity: lastActivity };

      // Форматируем created_at для отображения в формате ДД.ММ.ГГГГ ЧЧ:ММ
      if (user.created_at) {
        const date = new Date(user.created_at);
        user.created_at_formatted = `${date.getDate().toString().padStart(2, '0')}.${(date.getMonth() + 1).toString().padStart(2, '0')}.${date.getFullYear()} ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
      }

      console.log(`✅ Пользователь найден: ${user.first_name} (ID: ${userId})`);
      res.json({ 
        status: 'success', 
        user: user
      });
    } else {
      console.log(`ℹ️ Пользователь не найден в БД: ID ${userId}`);
      res.json({ 
        status: 'success', 
        user: null,
        message: 'Пользователь не найден'
      });
    }
  } catch (err) {
    console.error(`❌ Ошибка поиска пользователя ${userId}:`, err.message);
    res.status(500).json({ 
      status: 'error', 
      message: 'Ошибка поиска пользователя', 
      error: err.message
    });
  } finally {
    if (client) client.release();
  }
});

// Создать нового пользователя
app.post('/api/user', async (req, res) => {
  const { 
    id, 
    first_name, 
    last_name, 
    username, 
    language_code, 
    is_premium, 
    photo_url, 
    allows_write_to_pm 
  } = req.body;

  logRequest(req, `➕ Создание пользователя: ${first_name} (ID: ${id})`);
  console.log(`📝 Полученные данные:`, JSON.stringify(req.body, null, 2));

  if (!id || !first_name) {
    console.log('❌ Недостаточно данных для создания пользователя');
    return res.status(400).json({ 
      status: 'error', 
      message: 'ID и имя пользователя обязательны' 
    });
  }

  let client;
  try {
    client = await pool.connect();

    // Проверяем, не существует ли уже такой пользователь
    const existingUser = await client.query('SELECT id FROM users WHERE id = $1', [id]);
    if (existingUser.rows.length > 0) {
      console.log(`⚠️ Пользователь уже существует: ID ${id}`);
      // Возвращаем существующего пользователя вместо ошибки
      const user = await client.query('SELECT * FROM users WHERE id = $1', [id]);
      return res.json({ 
        status: 'success', 
        message: 'Пользователь уже существует',
        user: user.rows[0]
      });
    }

    const result = await client.query(`
      INSERT INTO users (
        id, 
        first_name, 
        last_name, 
        username, 
        language_code, 
        is_premium, 
        photo_url, 
        allows_write_to_pm, 
        balance, 
        cards
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        id, 
        first_name, 
        last_name || null, 
        username || null, 
        language_code || 'en', 
        is_premium || false, 
        photo_url || null, 
        allows_write_to_pm || false, 
        10, 
        '[]'
      ]
    );

    console.log(`✅ Пользователь создан: ${first_name} (ID: ${id}), баланс: 10`);
    console.log(`✅ Структура пользователя:`, result.rows[0]);

    res.json({ 
      status: 'success', 
      message: 'Пользователь создан!', 
      user: result.rows[0] 
    });
  } catch (err) {
    console.error(`❌ Ошибка создания пользователя ${id}:`, err.message);
    console.error(`❌ Детали ошибки:`, err);
    res.status(500).json({ 
      status: 'error', 
      message: 'Ошибка создания пользователя', 
      error: err.message,
      details: err.detail || 'Нет дополнительных деталей'
    });
  } finally {
    if (client) client.release();
  }
});

// Обновить баланс пользователя
app.put('/api/user/:id/balance', async (req, res) => {
  const userId = req.params.id;
  const { balance } = req.body;
  logRequest(req, `💰 Обновление баланса пользователя ID: ${userId} на ${balance}`);

  if (balance === undefined || balance === null) {
    return res.status(400).json({ 
      status: 'error', 
      message: 'Баланс обязателен' 
    });
  }

  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      'UPDATE users SET balance = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
      [balance, userId]
    );

    if (result.rows.length > 0) {
      console.log(`✅ Баланс обновлен для пользователя ID ${userId}: ${balance}`);
      res.json({ 
        status: 'success', 
        message: 'Баланс обновлен!', 
        user: result.rows[0] 
      });
    } else {
      console.log(`❌ Пользователь не найден для обновления баланса: ID ${userId}`);
      res.status(404).json({ 
        status: 'error', 
        message: 'Пользователь не найден' 
      });
    }
  } catch (err) {
    console.error(`❌ Ошибка обновления баланса ${userId}:`, err.message);
    res.status(500).json({ 
      status: 'error', 
      message: 'Ошибка обновления баланса', 
      error: err.message
    });
  } finally {
    if (client) client.release();
  }
});






app.post('/api/user/:id/free-case', async (req, res) => {
  const userId = req.params.id;

  // --- Твои карточки и шансы (лучше вынести в конфиг) ---
  const caseConfig = [
    { name:'Сериков', rarity:'rare', chance:60 },
    { name:'Барулин', rarity:'superrare', chance:30 },
    { name:'Грицюк', rarity:'epic', chance:6 },
    { name:'Голдобин', rarity:'mythic', chance:3 },
    { name:'Радулов', rarity:'legendary', chance:1 }
  ];
  const COOLDOWN = 60 * 1000; // 1 минута (миллисекунды)

  let client;
  try {
    client = await pool.connect();
    const userRes = await client.query('SELECT cards, case_free FROM users WHERE id = $1', [userId]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'Пользователь не найден' });
    }
    const user = userRes.rows[0];
    const now = Date.now();
    if (user.case_free && now < Number(user.case_free)) {
      const wait = Math.ceil((Number(user.case_free) - now)/1000);
      return res.status(400).json({
        status: 'error',
        message: `До следующего открытия ${wait} сек.`,
        wait: wait
      });
    }
    // --- Выпадение карточки по шансам ---
    let total = caseConfig.reduce((s,c)=>s+c.chance,0), rnd = Math.random()*total, sum=0, card=null;
    for (let c of caseConfig) {
      sum += c.chance;
      if (rnd <= sum) { card = c; break; }
    }
    if (!card) card = caseConfig[0];
    // --- Добавляем карточку пользователю ---
    let cards = user.cards || '';
    let newCards = (!cards || cards.trim()==='' || cards==='[]') ? card.name : cards.trim() + ' ' + card.name;
    let nextTime = now + COOLDOWN;
    await client.query(
      'UPDATE users SET cards = $1, case_free = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [newCards, nextTime, userId]
    );
    res.json({
      status: 'success',
      card: { name: card.name, rarity: card.rarity },
      next: nextTime,
      next_sec: Math.ceil((nextTime-now)/1000),
      cards: newCards
    });
  } catch (e) {
    res.status(500).json({ status: 'error', message: 'Ошибка сервера', error: e.message });
  } finally {
    if (client) client.release();
  }
});








// Покупка карточки
app.post('/api/user/:id/buy-card', async (req, res) => {
  const userId = req.params.id;
  const { cardName, price } = req.body;
  logRequest(req, `🛒 Покупка карточки: ${cardName} за ${price} клюшек (ID: ${userId})`);

  if (!cardName || !price) {
    return res.status(400).json({ 
      status: 'error', 
      message: 'Название карточки и цена обязательны' 
    });
  }

  let client;
  try {
    client = await pool.connect();

    // Получаем текущие данные пользователя
    const userResult = await client.query('SELECT * FROM users WHERE id = $1', [userId]);

    if (userResult.rows.length === 0) {
      console.log(`❌ Пользователь не найден для покупки: ID ${userId}`);
      return res.status(404).json({ 
        status: 'error', 
        message: 'Пользователь не найден' 
      });
    }

    const user = userResult.rows[0];

    // Проверяем баланс
    if (user.balance < price) {
      console.log(`❌ Недостаточно средств у пользователя ID ${userId}: ${user.balance} < ${price}`);
      return res.status(400).json({ 
        status: 'error', 
        message: 'Недостаточно клюшек для покупки' 
      });
    }

    // Обновляем карточки и баланс
    let currentCards = user.cards || '';
    let newCardsString = '';

    if (!currentCards || currentCards.trim() === '' || currentCards === '[]') {
      newCardsString = cardName;
    } else {
      newCardsString = currentCards.trim() + ' ' + cardName;
    }

    const newBalance = user.balance - price;

    console.log(`💾 Обновляем: баланс ${user.balance} -> ${newBalance}, карточки "${currentCards}" -> "${newCardsString}"`);

    // Обновляем в базе данных
    const updateResult = await client.query(
      'UPDATE users SET balance = $1, cards = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *',
      [newBalance, newCardsString, userId]
    );

    console.log(`✅ Карточка куплена: ${cardName} для пользователя ID ${userId}`);
    console.log(`✅ Новый баланс: ${newBalance}, карточки: "${newCardsString}"`);

    res.json({ 
      status: 'success', 
      message: 'Карточка успешно куплена!', 
      user: updateResult.rows[0],
      purchasedCard: cardName
    });
  } catch (err) {
    console.error(`❌ Ошибка покупки карточки ${cardName} для пользователя ${userId}:`, err.message);
    res.status(500).json({ 
      status: 'error', 
      message: 'Ошибка при покупке карточки', 
      error: err.message
    });
  } finally {
    if (client) client.release();
  }
});

// Крафт карточек
app.post('/api/user/:id/craft', async (req, res) => {
  const userId = req.params.id;
  const { recipe, selectedCards } = req.body;
  logRequest(req, `🔨 Крафт карточек: ${recipe} (ID: ${userId})`);

  if (!recipe || !selectedCards) {
    return res.status(400).json({ 
      status: 'error', 
      message: 'Рецепт и выбранные карточки обязательны' 
    });
  }

  // Правила крафта с возможными результатами
  const craftRecipes = {
    'rare': { 
      required: 3, 
      possibleCards: ['абросимов', 'барулин', 'уильям', 'гераськин', 'дыняк', 'камара', 'классон', 'конюшков', 'ли']
    },
    'superrare': { 
      required: 3, 
      possibleCards: ['грицюк', 'ткачев_а', 'барабанов', 'аймурзин', 'бориков', 'глотов', 'демченко', 'дроздов', 'ильенко', 'кара', 'мамин', 'локтионов', 'фу', 'рушан']
    },
    'epic': { 
      required: 3, 
      possibleCards: ['демидов', 'хмелевский', 'гутик', 'кагарлицкий', 'каюмов', 'голдобин']
    },
    'mythic': { 
      required: 3, 
      possibleCards: ['шабанов', 'галимов_арт', 'кравцов', 'кузнецов', 'радулов', 'ливо']
    }
  };

  const recipeData = craftRecipes[recipe];
  if (!recipeData) {
    return res.status(400).json({ 
      status: 'error', 
      message: 'Неизвестный рецепт' 
    });
  }

  let client;
  try {
    client = await pool.connect();

    // Получаем текущие данные пользователя
    const userResult = await client.query('SELECT * FROM users WHERE id = $1', [userId]);

    if (userResult.rows.length === 0) {
      console.log(`❌ Пользователь не найден для крафта: ID ${userId}`);
      return res.status(404).json({ 
        status: 'error', 
        message: 'Пользователь не найден' 
      });
    }

    const user = userResult.rows[0];

    // Парсим карточки пользователя
    let userCardsString = user.cards || '';
    const userCardsList = userCardsString.trim() === '' || userCardsString === '[]' ? [] : 
      userCardsString.trim().split(' ').map(card => card.trim()).filter(card => card.length > 0);

    // Подсчитываем карточки
    const userCardsCount = {};
    userCardsList.forEach(card => {
      const cardKey = card.toLowerCase();
      userCardsCount[cardKey] = (userCardsCount[cardKey] || 0) + 1;
    });

    console.log(`🎯 Карточки пользователя:`, userCardsCount);
    console.log(`🎯 Выбранные карточки:`, selectedCards);

    // Проверяем достаточность карточек
    const totalRequired = Object.values(selectedCards).reduce((sum, count) => sum + count, 0);
    if (totalRequired !== recipeData.required) {
      return res.status(400).json({ 
        status: 'error', 
        message: `Требуется ровно ${recipeData.required} карточек` 
      });
    }

    // Проверяем наличие карточек у пользователя
    for (const [cardKey, requiredCount] of Object.entries(selectedCards)) {
      const availableCount = userCardsCount[cardKey.toLowerCase()] || 0;
      if (availableCount < requiredCount) {
        return res.status(400).json({ 
          status: 'error', 
          message: `Недостаточно карточек "${cardKey}"` 
        });
      }
    }

    // Удаляем использованные карточки и добавляем новую
    let newCardsList = [...userCardsList];

    // Удаляем выбранные карточки
    for (const [cardKey, count] of Object.entries(selectedCards)) {
      for (let i = 0; i < count; i++) {
        const index = newCardsList.findIndex(card => card.toLowerCase() === cardKey.toLowerCase());
        if (index !== -1) {
          newCardsList.splice(index, 1);
        }
      }
    }

    // Выбираем случайную карточку из возможных
    const randomIndex = Math.floor(Math.random() * recipeData.possibleCards.length);
    const craftedCard = recipeData.possibleCards[randomIndex];

    // Добавляем новую карточку
    newCardsList.push(craftedCard);

    const newCardsString = newCardsList.join(' ');

    console.log(`💾 Обновляем карточки: "${userCardsString}" -> "${newCardsString}"`);

    // Обновляем в базе данных
    const updateResult = await client.query(
      'UPDATE users SET cards = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
      [newCardsString, userId]
    );

    console.log(`✅ Крафт завершен: ${recipe} -> ${craftedCard} для пользователя ID ${userId}`);

    res.json({ 
      status: 'success', 
      message: 'Крафт успешно завершен!', 
      user: updateResult.rows[0],
      craftedCard: craftedCard,
      recipe: recipe
    });
  } catch (err) {
    console.error(`❌ Ошибка крафта ${recipe} для пользователя ${userId}:`, err.message);
    res.status(500).json({ 
      status: 'error', 
      message: 'Ошибка при крафте карточек', 
      error: err.message
    });
  } finally {
    if (client) client.release();
  }
});

// ===== GAME API =====

// Создать игровую комнату
app.post('/api/game/room', async (req, res) => {
  const { room_code, player1, bet = 0 } = req.body;
  logRequest(req, `🎮 Создание игровой комнаты: ${room_code} (Player1: ${player1}, Bet: ${bet})`);

  if (!room_code || !player1) {
    return res.status(400).json({ 
      status: 'error', 
      message: 'Код комнаты и ID игрока обязательны' 
    });
  }

  let client;
  try {
    client = await pool.connect();

    // Проверяем, не находится ли игрок уже в активной игре
    const activeGame = await client.query(
      `SELECT id, room_code, game_state FROM game 
       WHERE (player1 = $1 OR player2 = $1) 
       AND game_state IN ('waiting', 'game')`,
      [player1]
    );

    if (activeGame.rows.length > 0) {
      console.log(`⚠️ Игрок ${player1} уже в активной игре: ${activeGame.rows[0].room_code}`);
      return res.status(400).json({ 
        status: 'error', 
        message: 'Вы находитесь в активной игре. Пожалуйста, повторите попытку позднее. Если проблема остается - обратитесь в поддержку в главном меню',
        active_room: activeGame.rows[0].room_code
      });
    }

    // Проверяем, не существует ли уже такая комната
    const existingRoom = await client.query('SELECT id FROM game WHERE room_code = $1', [room_code]);
    if (existingRoom.rows.length > 0) {
      console.log(`⚠️ Комната уже существует: ${room_code}`);
      return res.status(400).json({ 
        status: 'error', 
        message: 'Комната с таким кодом уже существует' 
      });
    }

    const result = await client.query(`
      INSERT INTO game (
        room_code, 
        player1, 
        bet
      ) VALUES ($1, $2, $3) RETURNING *`,
      [room_code, player1, bet]
    );

    console.log(`✅ Игровая комната создана: ${room_code} (ID: ${result.rows[0].id})`);

    res.json({ 
      status: 'success', 
      message: 'Игровая комната создана!', 
      room: result.rows[0] 
    });
  } catch (err) {
    console.error(`❌ Ошибка создания комнаты ${room_code}:`, err.message);
    res.status(500).json({ 
      status: 'error', 
      message: 'Ошибка создания игровой комнаты', 
      error: err.message
    });
  } finally {
    if (client) client.release();
  }
});

// Найти комнату по коду
app.get('/api/game/room/:room_code', async (req, res) => {
  const roomCode = req.params.room_code;
  logRequest(req, `🔍 Поиск комнаты: ${roomCode}`);

  let client;
  try {
    client = await pool.connect();
    const result = await client.query('SELECT * FROM game WHERE room_code = $1', [roomCode]);

    if (result.rows.length > 0) {
      const room = result.rows[0];

      // Проверяем статус комнаты
      if (room.game_state === 'closed') {
        console.log(`ℹ️ Комната закрыта: ${roomCode}`);
        res.status(404).json({ 
          status: 'error', 
          message: 'Комната закрыта' 
        });
        return;
      }

      console.log(`✅ Комната найдена: ${roomCode} (ID: ${room.id}, статус: ${room.game_state})`);
      res.json({ 
        status: 'success', 
        room: room
      });
    } else {
      console.log(`ℹ️ Комната не найдена: ${roomCode}`);
      res.status(404).json({ 
        status: 'error', 
        message: 'Комната не найдена' 
      });
    }
  } catch (err) {
    console.error(`❌ Ошибка поиска комнаты ${roomCode}:`, err.message);
    res.status(500).json({ 
      status: 'error', 
      message: 'Ошибка поиска комнаты', 
      error: err.message
    });
  } finally {
    if (client) client.release();
  }
});

// Получить комнату по ID
app.get('/api/game/room/id/:room_id', async (req, res) => {
  const roomId = req.params.room_id;
  logRequest(req, `🔍 Получение комнаты по ID: ${roomId}`);

  let client;
  try {
    client = await pool.connect();
    const result = await client.query('SELECT * FROM game WHERE id = $1', [roomId]);

    if (result.rows.length > 0) {
      console.log(`✅ Комната найдена по ID: ${roomId}`);
      res.json({ 
        status: 'success', 
        room: result.rows[0]
      });
    } else {
      console.log(`ℹ️ Комната не найдена по ID: ${roomId}`);
      res.status(404).json({ 
        status: 'error', 
        message: 'Комната не найдена' 
      });
    }
  } catch (err) {
    console.error(`❌ Ошибка получения комнаты ${roomId}:`, err.message);
    res.status(500).json({ 
      status: 'error', 
      message: 'Ошибка получения комнаты', 
      error: err.message
    });
  } finally {
    if (client) client.release();
  }
});

// Проверить активные игры пользователя
app.get('/api/game/check-active/:user_id', async (req, res) => {
  const userId = req.params.user_id;
  logRequest(req, `🔍 Проверка активных игр пользователя: ${userId}`);

  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      `SELECT id, room_code, game_state, player1, player2, bet FROM game 
       WHERE (player1 = $1 OR player2 = $1) 
       AND game_state IN ('waiting', 'game')`,
      [userId]
    );

    if (result.rows.length > 0) {
      console.log(`⚠️ Найдена активная игра для пользователя ${userId}: ${result.rows[0].room_code}`);
      res.json({ 
        status: 'success', 
        active_game: result.rows[0]
      });
    } else {
      console.log(`✅ Активных игр не найдено для пользователя ${userId}`);
      res.json({ 
        status: 'success', 
        active_game: null
      });
    }
  } catch (err) {
    console.error(`❌ Ошибка проверки активных игр ${userId}:`, err.message);
    res.status(500).json({ 
      status: 'error', 
      message: 'Ошибка проверки активных игр', 
      error: err.message
    });
  } finally {
    if (client) client.release();
  }
});

// Обновить данные комнаты
app.put('/api/game/room/:room_id', async (req, res) => {
  const roomId = req.params.room_id;
  const updates = req.body;
  logRequest(req, `🔄 Обновление комнаты ID: ${roomId} (${JSON.stringify(updates)})`);

  let client;
  try {
    client = await pool.connect();

    // Если добавляется player2, проверяем что он не в другой активной игре
    if (updates.player2) {
      const activeGame = await client.query(
        `SELECT id, room_code, game_state FROM game 
         WHERE (player1 = $1 OR player2 = $1) 
         AND game_state IN ('waiting', 'game')
         AND id != $2`,
        [updates.player2, roomId]
      );

      if (activeGame.rows.length > 0) {
        console.log(`⚠️ Игрок ${updates.player2} уже в активной игре: ${activeGame.rows[0].room_code}`);
        return res.status(400).json({ 
          status: 'error', 
          message: 'Вы находитесь в активной игре. Пожалуйста, повторите попытку позднее. Если проблема остается - обратитесь в поддержку в главном меню',
          active_room: activeGame.rows[0].room_code
        });
      }
    }

    // Динамически строим запрос на обновление
    const updateFields = [];
    const values = [];
    let valueIndex = 1;

    Object.keys(updates).forEach(key => {
      if (updates[key] !== undefined) {
        updateFields.push(`${key} = $${valueIndex}`);
        values.push(updates[key]);
        valueIndex++;
      }
    });

    if (updateFields.length === 0) {
      return res.status(400).json({
        status: 'error',
        message: 'Нет данных для обновления'
      });
    }

    updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(roomId);

    const query = `UPDATE game SET ${updateFields.join(', ')} WHERE id = $${valueIndex} RETURNING *`;
    const result = await client.query(query, values);

    if (result.rows.length > 0) {
      console.log(`✅ Комната обновлена: ID ${roomId}`);
      res.json({ 
        status: 'success', 
        message: 'Комната обновлена!', 
        room: result.rows[0] 
      });
    } else {
      console.log(`❌ Комната не найдена для обновления: ID ${roomId}`);
      res.status(404).json({ 
        status: 'error', 
        message: 'Комната не найдена' 
      });
    }
  } catch (err) {
    console.error(`❌ Ошибка обновления комнаты ${roomId}:`, err.message);
    res.status(500).json({ 
      status: 'error', 
      message: 'Ошибка обновления комнаты', 
      error: err.message
    });
  } finally {
    if (client) client.release();
  }
});

// Обновить статистику игрока
app.put('/api/user/:id/game-stats', async (req, res) => {
  const userId = req.params.id;
  const { winner, games, loses } = req.body;
  logRequest(req, `📊 Обновление статистики игрока ID: ${userId} (games: ${games}, winner: ${winner}, loses: ${loses})`);

  let client;
  try {
    client = await pool.connect();

    // Получаем текущую статистику
    const currentStats = await client.query('SELECT winner, games, loses FROM users WHERE id = $1', [userId]);

    if (currentStats.rows.length === 0) {
      return res.status(404).json({ 
        status: 'error', 
        message: 'Пользователь не найден' 
      });
    }

    const current = currentStats.rows[0];
    const newWinner = current.winner + (winner || 0);
    const newGames = current.games + (games || 0);
    const newLoses = current.loses + (loses || 0);

    // Обновляем статистику
    const result = await client.query(
      'UPDATE users SET winner = $1, games = $2, loses = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4 RETURNING *',
      [newWinner, newGames, newLoses, userId]
    );

    console.log(`✅ Статистика обновлена для пользователя ID ${userId}: игр ${newGames}, побед ${newWinner}, поражений ${newLoses}`);

    res.json({ 
      status: 'success', 
      message: 'Статистика обновлена!', 
      user: result.rows[0] 
    });
  } catch (err) {
    console.error(`❌ Ошибка обновления статистики ${userId}:`, err.message);
    res.status(500).json({ 
      status: 'error', 
      message: 'Ошибка обновления статистики', 
      error: err.message
    });
  } finally {
    if (client) client.release();
  }
});

// Получить лидерборд по балансу
app.get('/api/leaderboard', async (req, res) => {
  logRequest(req, '🏆 Получение лидерборда');

  let client;
  try {
    client = await pool.connect();

    // Получаем топ 10 по балансу
    const result = await client.query(
      'SELECT id, first_name, last_name, username, balance, photo_url FROM users ORDER BY balance DESC LIMIT 10'
    );

    console.log(`✅ Лидерборд загружен: ${result.rows.length} пользователей`);

    res.json({ 
      status: 'success', 
      leaderboard: result.rows
    });
  } catch (err) {
    console.error(`❌ Ошибка получения лидерборда:`, err.message);
    res.status(500).json({ 
      status: 'error', 
      message: 'Ошибка получения лидерборда', 
      error: err.message
    });
  } finally {
    if (client) client.release();
  }
});

// Получить позицию пользователя в лидерборде
app.get('/api/leaderboard/position/:user_id', async (req, res) => {
  const userId = req.params.user_id;
  logRequest(req, `🏆 Получение позиции пользователя ID: ${userId}`);

  let client;
  try {
    client = await pool.connect();

    // Получаем позицию пользователя
    const result = await client.query(`
      SELECT position FROM (
        SELECT id, ROW_NUMBER() OVER (ORDER BY balance DESC) as position 
        FROM users
      ) ranked 
      WHERE id = $1
    `, [userId]);

    if (result.rows.length > 0) {
      console.log(`✅ Позиция пользователя ID ${userId}: ${result.rows[0].position}`);
      res.json({ 
        status: 'success', 
        position: result.rows[0].position
      });
    } else {
      res.json({ 
        status: 'success', 
        position: null
      });
    }
  } catch (err) {
    console.error(`❌ Ошибка получения позиции ${userId}:`, err.message);
    res.status(500).json({ 
      status: 'error', 
      message: 'Ошибка получения позиции', 
      error: err.message
    });
  } finally {
    if (client) client.release();
  }
});

// Удалить комнату
app.delete('/api/game/room/:room_id', async (req, res) => {
  const roomId = req.params.room_id;
  logRequest(req, `🗑️ Удаление комнаты ID: ${roomId}`);

  let client;
  try {
    client = await pool.connect();
    const result = await client.query('DELETE FROM game WHERE id = $1 RETURNING *', [roomId]);

    if (result.rows.length > 0) {
      console.log(`✅ Комната удалена: ID ${roomId}`);
      res.json({ 
        status: 'success', 
        message: 'Комната удалена!' 
      });
    } else {
      console.log(`❌ Комната не найдена для удаления: ID ${roomId}`);
      res.status(404).json({ 
        status: 'error', 
        message: 'Комната не найдена' 
      });
    }
  } catch (err) {
    console.error(`❌ Ошибка удаления комнаты ${roomId}:`, err.message);
    res.status(500).json({ 
      status: 'error', 
      message: 'Ошибка удаления комнаты', 
      error: err.message
    });
  } finally {
    if (client) client.release();
  }
});

// Функция автоочистки закрытых комнат и неактивных создателей
async function cleanupClosedRooms() {
  let client;
  try {
    client = await pool.connect();

    // Закрываем комнаты в состоянии waiting, которые не обновлялись более 5 минут (неактивный создатель)
    const inactiveResult = await client.query(`
      UPDATE game 
      SET game_state = 'closed', updated_at = CURRENT_TIMESTAMP 
      WHERE game_state = 'waiting' 
      AND updated_at < NOW() - INTERVAL '5 minutes'
      RETURNING room_code
    `);

    if (inactiveResult.rows.length > 0) {
      console.log(`🔒 Закрыто неактивных комнат: ${inactiveResult.rows.length}`);
    }

    // Удаляем комнаты со статусом 'closed' которые были закрыты более 10 секунд назад
    const closedResult = await client.query(`
      DELETE FROM game 
      WHERE game_state = 'closed' 
      AND updated_at < NOW() - INTERVAL '10 seconds'
      RETURNING room_code
    `);

    if (closedResult.rows.length > 0) {
      console.log(`🧹 Удалено закрытых комнат: ${closedResult.rows.length}`);
    }

    // Автоматически завершаем игры, которые идут более 30 секунд
    const autoFinishResult = await client.query(`
      UPDATE game 
      SET game_state = 'finished', updated_at = CURRENT_TIMESTAMP 
      WHERE game_state = 'game' 
      AND updated_at < NOW() - INTERVAL '30 seconds'
      RETURNING room_code
    `);

    if (autoFinishResult.rows.length > 0) {
      console.log(`⏰ Автозавершено игр: ${autoFinishResult.rows.length}`);
    }

    // Удаляем старые завершенные игры (старше 1 минуты)
    const finishedResult = await client.query(`
      DELETE FROM game 
      WHERE game_state = 'finished' 
      AND updated_at < NOW() - INTERVAL '1 minute'
      RETURNING room_code
    `);

    if (finishedResult.rows.length > 0) {
      console.log(`🧹 Удалено завершенных игр: ${finishedResult.rows.length}`);
    }

  } catch (err) {
    console.error('❌ Ошибка очистки комнат:', err.message);
  } finally {
    if (client) client.release();
  }
}

// Передача карточки между пользователями
app.post('/api/user/transfer-card', async (req, res) => {
  const { fromUserId, toUserId, cardKey } = req.body;
  logRequest(req, `🔄 Передача карточки: ${cardKey} от ${fromUserId} к ${toUserId}`);

  if (!fromUserId || !toUserId || !cardKey) {
    return res.status(400).json({ 
      status: 'error', 
      message: 'Все поля обязательны: fromUserId, toUserId, cardKey' 
    });
  }

  if (fromUserId === toUserId) {
    return res.status(400).json({ 
      status: 'error', 
      message: 'Нельзя передать карточку самому себе' 
    });
  }

  let client;
  try {
    client = await pool.connect();

    // Начинаем транзакцию
    await client.query('BEGIN');

    // Получаем данные отправителя
    const fromUserResult = await client.query('SELECT * FROM users WHERE id = $1', [fromUserId]);
    if (fromUserResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ 
        status: 'error', 
        message: 'Отправитель не найден' 
      });
    }

    // Получаем данные получателя
    const toUserResult = await client.query('SELECT * FROM users WHERE id = $1', [toUserId]);
    if (toUserResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ 
        status: 'error', 
        message: 'Получатель не найден' 
      });
    }

    const fromUser = fromUserResult.rows[0];
    const toUser = toUserResult.rows[0];

    // Парсим карточки отправителя
    let fromUserCardsString = fromUser.cards || '';
    const fromUserCardsList = fromUserCardsString.trim() === '' || fromUserCardsString === '[]' ? [] : 
      fromUserCardsString.trim().split(' ').map(card => card.trim()).filter(card => card.length > 0);

    // Проверяем наличие карточки у отправителя
    const cardIndex = fromUserCardsList.findIndex(card => card.toLowerCase() === cardKey.toLowerCase());
    if (cardIndex === -1) {
      await client.query('ROLLBACK');
      console.log(`❌ Карточка ${cardKey} не найдена у пользователя ${fromUserId}`);
      return res.status(400).json({ 
        status: 'error', 
        message: 'У вас нет такой карточки' 
      });
    }

    // Удаляем карточку у отправителя
    fromUserCardsList.splice(cardIndex, 1);
    const newFromUserCardsString = fromUserCardsList.join(' ');

    // Парсим карточки получателя
    let toUserCardsString = toUser.cards || '';
    const toUserCardsList = toUserCardsString.trim() === '' || toUserCardsString === '[]' ? [] : 
      toUserCardsString.trim().split(' ').map(card => card.trim()).filter(card => card.length > 0);

    // Добавляем карточку получателю
    toUserCardsList.push(cardKey);
    const newToUserCardsString = toUserCardsList.join(' ');

    console.log(`💾 Передача карточки ${cardKey}:`);
    console.log(`💾 Отправитель: "${fromUserCardsString}" -> "${newFromUserCardsString}"`);
    console.log(`💾 Получатель: "${toUserCardsString}" -> "${newToUserCardsString}"`);

    // Обновляем карточки отправителя
    await client.query(
      'UPDATE users SET cards = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [newFromUserCardsString, fromUserId]
    );

    // Обновляем карточки получателя
    await client.query(
      'UPDATE users SET cards = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [newToUserCardsString, toUserId]
    );

    // Подтверждаем транзакцию
    await client.query('COMMIT');

    console.log(`✅ Карточка ${cardKey} успешно передана от ${fromUserId} к ${toUserId}`);

    res.json({ 
      status: 'success', 
      message: 'Карточка успешно передана!',
      transferDetails: {
        cardKey: cardKey,
        fromUser: fromUser.first_name,
        toUser: toUser.first_name
      }
    });
  } catch (err) {
    // Откатываем транзакцию при ошибке
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('❌ Ошибка отката транзакции:', rollbackErr.message);
      }
    }

    console.error(`❌ Ошибка передачи карточки ${cardKey}:`, err.message);
    res.status(500).json({ 
      status: 'error', 
      message: 'Ошибка при передаче карточки', 
      error: err.message
    });
  } finally {
    if (client) client.release();
  }
});

// Продажа карточки
app.post('/api/user/:id/sell-card', async (req, res) => {
  const userId = req.params.id;
  const { cardKey, price } = req.body;
  logRequest(req, `💰 Продажа карточки: ${cardKey} за ${price} клюшек (ID: ${userId})`);

  if (!cardKey || !price) {
    return res.status(400).json({ 
      status: 'error', 
      message: 'Ключ карточки и цена обязательны' 
    });
  }

  let client;
  try {
    client = await pool.connect();

    // Получаем текущие данные пользователя
    const userResult = await client.query('SELECT * FROM users WHERE id = $1', [userId]);

    if (userResult.rows.length === 0) {
      console.log(`❌ Пользователь не найден для продажи: ID ${userId}`);
      return res.status(404).json({ 
        status: 'error', 
        message: 'Пользователь не найден' 
      });
    }

    const user = userResult.rows[0];

    // Парсим карточки пользователя
    let currentCards = user.cards || '';
    let cardsList = currentCards.trim() === '' || currentCards === '[]' ? [] : 
      currentCards.trim().split(' ').map(card => card.trim()).filter(card => card.length > 0);

    // Проверяем наличие карточки у пользователя
    const cardIndex = cardsList.findIndex(card => card.toLowerCase() === cardKey.toLowerCase());
    if (cardIndex === -1) {
      console.log(`❌ Карточка ${cardKey} не найдена у пользователя ${userId}`);
      return res.status(400).json({ 
        status: 'error', 
        message: 'У вас нет такой карточки' 
      });
    }

    // Удаляем карточку из инвентаря
    cardsList.splice(cardIndex, 1);
    const newCardsString = cardsList.join(' ');
    const newBalance = user.balance + price;

    console.log(`💾 Продажа: баланс ${user.balance} -> ${newBalance}, карточки "${currentCards}" -> "${newCardsString}"`);

    // Обновляем в базе данных
    const updateResult = await client.query(
      'UPDATE users SET balance = $1, cards = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *',
      [newBalance, newCardsString, userId]
    );

    console.log(`✅ Карточка продана: ${cardKey} пользователем ID ${userId} за ${price} клюшек`);

    res.json({ 
      status: 'success', 
      message: 'Карточка успешно продана!', 
      user: updateResult.rows[0],
      soldCard: cardKey,
      earnedAmount: price
    });
  } catch (err) {
    console.error(`❌ Ошибка продажи карточки ${cardKey} пользователем ${userId}:`, err.message);
    res.status(500).json({ 
      status: 'error', 
      message: 'Ошибка при продаже карточки', 
      error: err.message
    });
  } finally {
    if (client) client.release();
  }
});

// Проверка подписки на канал
app.get('/api/check-subscription/:user_id', async (req, res) => {
  const userId = req.params.user_id;
  logRequest(req, `📺 Проверка подписки пользователя ID: ${userId}`);

  const TELEGRAM_BOT_TOKEN = '8147352192:AAFSieCfgxplnvkMyHGHqzkisinBjP1lx-I';
  const CHANNEL_ID = '-1002654964467';

  try {
    const telegramApiUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getChatMember?chat_id=${CHANNEL_ID}&user_id=${userId}`;
    
    const response = await fetch(telegramApiUrl);
    const data = await response.json();

    if (data.ok) {
      const status = data.result.status;
      const isSubscribed = ['creator', 'administrator', 'member'].includes(status);
      
      console.log(`✅ Статус подписки пользователя ${userId}: ${status} (подписан: ${isSubscribed})`);
      
      res.json({ 
        status: 'success', 
        isSubscribed: isSubscribed,
        subscriptionStatus: status
      });
    } else {
      console.log(`❌ Ошибка проверки подписки: ${data.description}`);
      res.json({ 
        status: 'success', 
        isSubscribed: false,
        error: data.description
      });
    }
  } catch (err) {
    console.error(`❌ Ошибка проверки подписки ${userId}:`, err.message);
    res.status(500).json({ 
      status: 'error', 
      message: 'Ошибка проверки подписки', 
      error: err.message
    });
  }
});

// Получить количество пользователей онлайн (активность в течение 5 минут)
app.get('/api/online-count', async (req, res) => {
  logRequest(req, '📊 Получение количества пользователей онлайн');

  let client;
  try {
    client = await pool.connect();

    // Подсчитываем пользователей, которые были активны в течение последних 5 минут
    const result = await client.query(`
      SELECT COUNT(*) as online_count 
      FROM users 
      WHERE updated_at > NOW() - INTERVAL '5 minutes'
    `);

    const onlineCount = parseInt(result.rows[0].online_count) || 0;

    console.log(`✅ Пользователей онлайн: ${onlineCount}`);

    res.json({ 
      status: 'success', 
      onlineCount: onlineCount
    });
  } catch (err) {
    console.error(`❌ Ошибка получения онлайна:`, err.message);
    res.status(500).json({ 
      status: 'error', 
      message: 'Ошибка получения онлайна', 
      error: err.message
    });
  } finally {
    if (client) client.release();
  }
});

// ===== SPONSORS API =====

// Получить список спонсоров
app.get('/api/sponsors', async (req, res) => {
  logRequest(req, '✨ Получение списка спонсоров');

  let client;
  try {
    client = await pool.connect();
    const result = await client.query('SELECT * FROM sponsors ORDER BY position ASC');

    console.log(`✅ Спонсоры загружены: ${result.rows.length}`);
    res.json({ 
      status: 'success', 
      sponsors: result.rows
    });
  } catch (err) {
    console.error(`❌ Ошибка получения спонсоров:`, err.message);
    res.status(500).json({ 
      status: 'error', 
      message: 'Ошибка получения спонсоров', 
      error: err.message
    });
  } finally {
    if (client) client.release();
  }
});

// Добавить или обновить спонсора (админ)
app.put('/api/admin/sponsors/:position', async (req, res) => {
  const position = req.params.position;
  const { name, url_channel, photo_url } = req.body;
  logRequest(req, `✨ Обновление спонсора на позиции ${position}: ${name}`);

  if (!name || !url_channel || !photo_url) {
    return res.status(400).json({ 
      status: 'error', 
      message: 'Все поля обязательны: name, url_channel, photo_url' 
    });
  }

  const positionNum = parseInt(position);
  if (![1, 2, 3].includes(positionNum)) {
    return res.status(400).json({ 
      status: 'error', 
      message: 'Позиция должна быть 1, 2 или 3' 
    });
  }

  let client;
  try {
    client = await pool.connect();
    
    // Проверяем существует ли спонсор на этой позиции
    const existingResult = await client.query('SELECT position FROM sponsors WHERE position = $1', [positionNum]);
    
    if (existingResult.rows.length > 0) {
      // Обновляем существующего спонсора
      const result = await client.query(
        'UPDATE sponsors SET name = $1, url_channel = $2, photo_url = $3, updated_at = CURRENT_TIMESTAMP WHERE position = $4 RETURNING *',
        [name, url_channel, photo_url, positionNum]
      );
      console.log(`✅ Спонсор обновлен на позиции ${positionNum}: ${name}`);
      res.json({ 
        status: 'success', 
        message: 'Спонсор обновлен!', 
        sponsor: result.rows[0] 
      });
    } else {
      // Создаем нового спонсора
      const result = await client.query(
        'INSERT INTO sponsors (position, name, url_channel, photo_url) VALUES ($1, $2, $3, $4) RETURNING *',
        [positionNum, name, url_channel, photo_url]
      );
      console.log(`✅ Спонсор добавлен на позицию ${positionNum}: ${name}`);
      res.json({ 
        status: 'success', 
        message: 'Спонсор добавлен!', 
        sponsor: result.rows[0] 
      });
    }
  } catch (err) {
    console.error(`❌ Ошибка работы со спонсором ${positionNum}:`, err.message);
    res.status(500).json({ 
      status: 'error', 
      message: 'Ошибка работы со спонсором', 
      error: err.message
    });
  } finally {
    if (client) client.release();
  }
});

// Удалить спонсора (админ)
app.delete('/api/admin/sponsors/:position', async (req, res) => {
  const position = req.params.position;
  logRequest(req, `🗑️ Удаление спонсора с позиции ${position}`);

  const positionNum = parseInt(position);
  if (![1, 2, 3].includes(positionNum)) {
    return res.status(400).json({ 
      status: 'error', 
      message: 'Позиция должна быть 1, 2 или 3' 
    });
  }

  let client;
  try {
    client = await pool.connect();
    const result = await client.query('DELETE FROM sponsors WHERE position = $1 RETURNING *', [positionNum]);

    if (result.rows.length > 0) {
      console.log(`✅ Спонсор удален с позиции ${positionNum}`);
      res.json({ 
        status: 'success', 
        message: 'Спонсор удален!' 
      });
    } else {
      console.log(`❌ Спонсор не найден на позиции ${positionNum}`);
      res.status(404).json({ 
        status: 'error', 
        message: 'Спонсор не найден' 
      });
    }
  } catch (err) {
    console.error(`❌ Ошибка удаления спонсора ${positionNum}:`, err.message);
    res.status(500).json({ 
      status: 'error', 
      message: 'Ошибка удаления спонсора', 
      error: err.message
    });
  } finally {
    if (client) client.release();
  }
});

// ===== CASES API =====

// Открыть кейс
app.post('/api/case/open', async (req, res) => {
  const { userId, caseType } = req.body;
  logRequest(req, `📦 Открытие кейса: ${caseType} (ID: ${userId})`);

  if (!userId || !caseType) {
    return res.status(400).json({ 
      status: 'error', 
      message: 'ID пользователя и тип кейса обязательны' 
    });
  }

  // Конфигурация кейсов
  const caseConfigs = {
    'start': {
      price: 29,
      rewards: {
        'rare': { weight: 70, cards: ['абросимов', 'барулин', 'уильям', 'гераськин', 'дыняк', 'камара', 'классон', 'конюшков', 'ли'] },
        'superrare': { weight: 25, cards: ['грицюк', 'ткачев_а', 'барабанов', 'аймурзин', 'бориков', 'глотов', 'демченко', 'дроздов', 'ильенко', 'кара', 'мамин', 'локтионов', 'фу', 'рушан'] },
        'epic': { weight: 5, cards: ['демидов', 'хмелевский', 'гутик', 'кагарлицкий', 'каюмов', 'голдобин'] }
      }
    }
  };

  const caseConfig = caseConfigs[caseType];
  if (!caseConfig) {
    return res.status(400).json({ 
      status: 'error', 
      message: 'Неизвестный тип кейса' 
    });
  }

  let client;
  try {
    client = await pool.connect();

    // Получаем данные пользователя
    const userResult = await client.query('SELECT * FROM users WHERE id = $1', [userId]);

    if (userResult.rows.length === 0) {
      console.log(`❌ Пользователь не найден для открытия кейса: ID ${userId}`);
      return res.status(404).json({ 
        status: 'error', 
        message: 'Пользователь не найден' 
      });
    }

    const user = userResult.rows[0];

    // Проверяем баланс
    if (user.balance < caseConfig.price) {
      console.log(`❌ Недостаточно средств у пользователя ID ${userId}: ${user.balance} < ${caseConfig.price}`);
      return res.status(400).json({ 
        status: 'error', 
        message: 'Недостаточно клюшек для открытия кейса' 
      });
    }

    // Определяем редкость выпавшей карточки
    const random = Math.random() * 100;
    let selectedRarity = 'rare';
    let cumulativeWeight = 0;

    for (const [rarity, config] of Object.entries(caseConfig.rewards)) {
      cumulativeWeight += config.weight;
      if (random <= cumulativeWeight) {
        selectedRarity = rarity;
        break;
      }
    }

    // Выбираем случайную карточку из выбранной редкости
    const availableCards = caseConfig.rewards[selectedRarity].cards;
    const selectedCard = availableCards[Math.floor(Math.random() * availableCards.length)];

    // Обновляем карточки и баланс пользователя
    let currentCards = user.cards || '';
    let newCardsString = '';

    if (!currentCards || currentCards.trim() === '' || currentCards === '[]') {
      newCardsString = selectedCard;
    } else {
      newCardsString = currentCards.trim() + ' ' + selectedCard;
    }

    const newBalance = user.balance - caseConfig.price;

    console.log(`💾 Открытие кейса: баланс ${user.balance} -> ${newBalance}, добавлена карточка "${selectedCard}" (${selectedRarity})`);

    // Обновляем в базе данных
    const updateResult = await client.query(
      'UPDATE users SET balance = $1, cards = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *',
      [newBalance, newCardsString, userId]
    );

    console.log(`✅ Кейс открыт: ${selectedCard} (${selectedRarity}) для пользователя ID ${userId}`);

    res.json({ 
      status: 'success', 
      message: 'Кейс успешно открыт!', 
      card: {
        name: selectedCard,
        rarity: selectedRarity
      },
      newBalance: newBalance,
      user: updateResult.rows[0]
    });
  } catch (err) {
    console.error(`❌ Ошибка открытия кейса ${caseType} для пользователя ${userId}:`, err.message);
    res.status(500).json({ 
      status: 'error', 
      message: 'Ошибка при открытии кейса', 
      error: err.message
    });
  } finally {
    if (client) client.release();
  }
});

// ===== ADMIN API =====

// Получить статус технических работ
app.get('/api/admin/maintenance', async (req, res) => {
  logRequest(req, '🔧 Получение статуса технических работ');

  let client;
  try {
    client = await pool.connect();
    const result = await client.query('SELECT maintenance, whitelist FROM admin LIMIT 1');

    if (result.rows.length > 0) {
      const maintenance = result.rows[0].maintenance;
      const whitelist = result.rows[0].whitelist || '';
      console.log(`✅ Статус техработ: ${maintenance}, whitelist: ${whitelist}`);
      res.json({ 
        status: 'success', 
        maintenance: maintenance,
        whitelist: whitelist
      });
    } else {
      // Если записи нет, создаем её
      await client.query('INSERT INTO admin (maintenance, whitelist) VALUES (0, \'\')');
      res.json({ 
        status: 'success', 
        maintenance: 0,
        whitelist: ''
      });
    }
  } catch (err) {
    console.error(`❌ Ошибка получения статуса техработ:`, err.message);
    res.status(500).json({ 
      status: 'error', 
      message: 'Ошибка получения статуса техработ', 
      error: err.message
    });
  } finally {
    if (client) client.release();
  }
});

// Обновить статус технических работ
app.put('/api/admin/maintenance', async (req, res) => {
  const { maintenance, whitelist } = req.body;
  logRequest(req, `🔧 Обновление статуса техработ: ${maintenance}, whitelist: ${whitelist}`);

  if (maintenance === undefined || maintenance === null) {
    return res.status(400).json({ 
      status: 'error', 
      message: 'Статус техработ обязателен' 
    });
  }

  let client;
  try {
    client = await pool.connect();
    
    // Проверяем есть ли запись
    const existingResult = await client.query('SELECT maintenance FROM admin LIMIT 1');
    
    if (existingResult.rows.length > 0) {
      // Обновляем существующую запись
      if (whitelist !== undefined) {
        await client.query(
          'UPDATE admin SET maintenance = $1, whitelist = $2',
          [maintenance, whitelist || '']
        );
      } else {
        await client.query('UPDATE admin SET maintenance = $1', [maintenance]);
      }
    } else {
      // Создаем новую запись
      await client.query('INSERT INTO admin (maintenance, whitelist) VALUES ($1, $2)', [maintenance, whitelist || '']);
    }

    console.log(`✅ Статус техработ обновлен: ${maintenance}`);
    res.json({ 
      status: 'success', 
      message: 'Статус техработ обновлен!', 
      maintenance: maintenance,
      whitelist: whitelist || ''
    });
  } catch (err) {
    console.error(`❌ Ошибка обновления статуса техработ:`, err.message);
    res.status(500).json({ 
      status: 'error', 
      message: 'Ошибка обновления статуса техработ', 
      error: err.message
    });
  } finally {
    if (client) client.release();
  }
});

// Получить список всех пользователей для админки
app.get('/api/admin/users', async (req, res) => {
  logRequest(req, '👥 Получение списка пользователей для админки');

  let client;
  try {
    client = await pool.connect();
    const result = await client.query(`
      SELECT id, first_name, last_name, username, balance, ban, photo_url, created_at 
      FROM users 
      ORDER BY created_at DESC
    `);

    console.log(`✅ Загружено пользователей: ${result.rows.length}`);
    res.json({ 
      status: 'success', 
      users: result.rows
    });
  } catch (err) {
    console.error(`❌ Ошибка получения пользователей:`, err.message);
    res.status(500).json({ 
      status: 'error', 
      message: 'Ошибка получения пользователей', 
      error: err.message
    });
  } finally {
    if (client) client.release();
  }
});

// Обновить карточки пользователя (админ)
app.put('/api/admin/user/:id/cards', async (req, res) => {
  const userId = req.params.id;
  const { cards } = req.body;
  logRequest(req, `🎴 Обновление карточек пользователя ID: ${userId} (админ)`);

  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      'UPDATE users SET cards = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
      [cards || '', userId]
    );

    if (result.rows.length > 0) {
      console.log(`✅ Карточки обновлены для пользователя ID ${userId}`);
      res.json({ 
        status: 'success', 
        message: 'Карточки обновлены!', 
        user: result.rows[0] 
      });
    } else {
      console.log(`❌ Пользователь не найден для обновления карточек: ID ${userId}`);
      res.status(404).json({ 
        status: 'error', 
        message: 'Пользователь не найден' 
      });
    }
  } catch (err) {
    console.error(`❌ Ошибка обновления карточек ${userId}:`, err.message);
    res.status(500).json({ 
      status: 'error', 
      message: 'Ошибка обновления карточек', 
      error: err.message
    });
  } finally {
    if (client) client.release();
  }
});

// Обновить статус бана пользователя (админ)
app.put('/api/admin/user/:id/ban', async (req, res) => {
  const userId = req.params.id;
  const { ban } = req.body;
  logRequest(req, `🔨 Обновление статуса бана пользователя ID: ${userId} -> ${ban}`);

  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      'UPDATE users SET ban = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
      [ban, userId]
    );

    if (result.rows.length > 0) {
      const statusText = ban === 1 ? 'заблокирован' : 'разблокирован';
      console.log(`✅ Пользователь ID ${userId} ${statusText}`);
      res.json({ 
        status: 'success', 
        message: `Пользователь ${statusText}!`, 
        user: result.rows[0] 
      });
    } else {
      console.log(`❌ Пользователь не найден для изменения бана: ID ${userId}`);
      res.status(404).json({ 
        status: 'error', 
        message: 'Пользователь не найден' 
      });
    }
  } catch (err) {
    console.error(`❌ Ошибка изменения бана ${userId}:`, err.message);
    res.status(500).json({ 
      status: 'error', 
      message: 'Ошибка изменения статуса бана', 
      error: err.message
    });
  } finally {
    if (client) client.release();
  }
});

// Start server
const server = app.listen(PORT, '0.0.0.0', async () => {
  console.log('🚀 Сервер запущен!');
  console.log('🚀 Порт:', PORT);
  console.log('🚀 URL: http://0.0.0.0:' + PORT);
  console.log('🚀 Environment:', process.env.NODE_ENV || 'development');
  await initDatabase();

  // Запускаем автоочистку каждую минуту
  setInterval(cleanupClosedRooms, 60000);
  console.log('🧹 Автоочистка комнат активирована (каждую минуту)');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('📴 Получен сигнал SIGTERM, завершаем работу сервера...');
  server.close(() => {
    pool.end(() => {
      console.log('📴 Сервер остановлен');
      process.exit(0);
    });
  });
});

process.on('SIGINT', () => {
  console.log('📴 Получен сигнал SIGINT, завершаем работу сервера...');
  server.close(() => {
    pool.end(() => {
      console.log('📴 Сервер остановлен');
      process.exit(0);
    });
  });
});
