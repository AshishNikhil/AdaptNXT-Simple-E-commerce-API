const { v4: uuidv4 } = require("uuid");
const express = require("express");
const { open } = require("sqlite");
const sqlite3 = require("sqlite3");
const path = require("path");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const app = express();
app.use(express.json());

const databasePath = path.join(__dirname, "ecom.db");

let database;

const initializeDbAndStartServer = async () => {
  try {
    database = await open({
      filename: databasePath,
      driver: sqlite3.Database,
    });
    app.listen(3000, () => {
      console.log("Server Running at http://localhost:3000/");
    });
  } catch (error) {
    console.log(`DB Error: ${error.message}`);
    process.exit(1);
  }
};

initializeDbAndStartServer();

// Register
app.post("/register/", async (req, res) => {
  const { username, password, name, usertype } = req.body;
  const dbUser = await database.get(
    `SELECT * FROM user WHERE username = '${username}'`
  );
  if (dbUser) {
    res.status(400).send("User already exists");
  } else if (password.length < 6) {
    res.status(400).send("Password is too short");
  } else {
    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = uuidv4();
    await database.run(`
      INSERT INTO user (name, username, password, usertype, user_id)
      VALUES ('${name}', '${username}', '${hashedPassword}', '${usertype}', '${userId}')
    `);
    res.send("User created successfully");
  }
});

// Login
app.post("/login/", async (req, res) => {
  const { username, password } = req.body;
  const dbUser = await database.get(
    `SELECT * FROM user WHERE username = '${username}'`
  );
  if (!dbUser) {
    res.status(400).send("Invalid user");
  } else {
    const isPasswordMatched = await bcrypt.compare(password, dbUser.password);
    if (!isPasswordMatched) {
      res.status(400).send("Invalid password");
    } else {
      const payload = { username };
      const jwtToken = jwt.sign(payload, "MY_SECRET_KEY");
      res.send({ jwtToken });
    }
  }
});

// Auth middleware
const authenticateUser = async (req, res, next) => {
  const authHeader = req.headers["authorization"];
  if (!authHeader) {
    return res.status(401).send("Invalid JWT Token");
  }
  const jwtToken = authHeader.split(" ")[1];
  jwt.verify(jwtToken, "MY_SECRET_KEY", async (error, payload) => {
    if (error) {
      res.status(401).send("Invalid JWT Token");
    } else {
      const user = await database.get(
        `SELECT * FROM user WHERE username = '${payload.username}'`
      );
      req.user = user;
      next();
    }
  });
};

// Get products
app.get("/products", async (req, res) => {
  let { search = "", category = "", limit = 10, offset = 0 } = req.query;
  search = `%${search}%`;
  category = `%${category}%`;
  const products = await database.all(`
    SELECT * FROM products
    WHERE name LIKE '${search}' AND category LIKE '${category}'
    LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)};
  `);
  res.send(products);
});

// Add product
app.post("/products", authenticateUser, async (req, res) => {
  const { name, category, price } = req.body;
  try {
    await database.run(`
      INSERT INTO products (name, category, price)
      VALUES ('${name}', '${category}', ${price});
    `);
    res.send("Product added");
  } catch (error) {
    res.status(500).send({ error: "Failed to add product" });
  }
});

// Update product
app.put("/products/:id", authenticateUser, async (req, res) => {
  const { name, category, price } = req.body;
  const { id } = req.params;
  try {
    await database.run(`
      UPDATE products
      SET name = '${name}', category = '${category}', price = ${price}
      WHERE id = ${id};
    `);
    res.send("Product updated");
  } catch (error) {
    res.status(500).send({ error: "Failed to update product" });
  }
});

// Delete product
app.delete("/products/:id", authenticateUser, async (req, res) => {
  const { id } = req.params;
  try {
    await database.run(`DELETE FROM products WHERE id = ${id}`);
    res.send("Product deleted");
  } catch (error) {
    res.status(500).send({ error: "Failed to delete product" });
  }
});

// View cart
app.get("/cart", authenticateUser, async (req, res) => {
  const userId = req.user.user_id;
  const cart = await database.all(`
    SELECT cart.id, products.name, products.price, cart.quantity
    FROM cart
    JOIN products ON cart.product_id = products.id
    WHERE cart.user_id = '${userId}'
  `);
  res.send(cart);
});

// Add to cart
app.post("/cart", authenticateUser, async (req, res) => {
  const { product_id, quantity } = req.body;
  const userId = req.user.user_id;
  const existing = await database.get(`
    SELECT * FROM cart
    WHERE user_id = '${userId}' AND product_id = ${product_id}
  `);
  if (existing) {
    await database.run(`
      UPDATE cart
      SET quantity = quantity + ${quantity}
      WHERE id = ${existing.id}
    `);
  } else {
    await database.run(`
      INSERT INTO cart (user_id, product_id, quantity)
      VALUES ('${userId}', ${product_id}, ${quantity})
    `);
  }
  res.send("Added to cart");
});

// Update cart
app.put("/cart/:id", authenticateUser, async (req, res) => {
  const { quantity } = req.body;
  await database.run(`
    UPDATE cart
    SET quantity = ${quantity}
    WHERE id = ${req.params.id} AND user_id = '${req.user.user_id}'
  `);
  res.send("Cart updated");
});

// Remove from cart
app.delete("/cart/:id", authenticateUser, async (req, res) => {
  await database.run(`
    DELETE FROM cart
    WHERE id = ${req.params.id} AND user_id = '${req.user.user_id}'
  `);
  res.send("Removed from cart");
});

// Place order
app.post("/orders", authenticateUser, async (req, res) => {
  const cartItems = await database.all(`
    SELECT * FROM cart WHERE user_id = '${req.user.user_id}'
  `);
  if (cartItems.length === 0) {
    return res.status(400).send("Cart is empty");
  }
  res.send("Order placed");
});

// View orders
app.get("/orders", authenticateUser, async (req, res) => {
  const orders = await database.all(`
    SELECT * FROM orders WHERE user_id = '${req.user.user_id}'
  `);
  const detailed = [];
  for (const order of orders) {
    const items = await database.all(`
      SELECT products.name, products.price, order_items.quantity
      FROM order_items
      JOIN products ON order_items.product_id = products.id
      WHERE order_items.order_id = ${order.id}
    `);
    detailed.push({ id: order.id, date: order.created_at, items });
  }
  res.send(detailed);
});

module.exports = app;
