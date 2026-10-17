# Pipe & Expense Management System (Cloud Edition) 🚀

A notebook-styled dynamic pipe and expense tracking system with **cloud accounts**, **MongoDB Atlas persistence**, and **real-time synchronization across multiple devices** (PCs, laptops, tablets, and phones).

Live Website: [https://pipline-t27l.vercel.app/](https://pipline-t27l.vercel.app/)

---

## ✨ Features & Upgrades

- **☁️ Cloud Accounts & Authentication**: Secure Sign Up, Sign In, and Logout powered by JWT tokens and `bcrypt` password hashing.
- **🔒 Complete User Isolation**: Every user account has its own isolated data space. Users only see and manage their own expenses and pipeline entries.
- **📱 Multi-Device Synchronization**: Sign in with the same account on desktop, laptop, tablet, or phone. Data syncs automatically across all active sessions.
- **🍃 MongoDB Atlas Database**: Replaces temporary browser-only storage with permanent cloud database storage.
- **🛡️ Safe Local Data Migration**: Automatically detects existing offline records on your device upon sign in and gives you the choice to safely upload them to your cloud account without losing any data.
- **⚡ Offline Fallback**: If internet connectivity is interrupted or database credentials are being configured, the system gracefully operates in local mode.
- **📝 Perforated Notebook Design**: Preserves handwritten notebook paper aesthetic, cursive typography (*Caveat*, *Patrick Hand*), column colors, and automatic numerical sorting.
- **🗑️ History & Restoration**: Dedicated history log of deleted entries with multi-column timestamps and one-click restoration.
- **📄 Printable PDF Export**: Download reports formatted cleanly for printing and distribution.

---

## 🛠️ Tech Stack & Architecture

- **Frontend**: Vanilla HTML5, CSS3, JavaScript (ES6+), `api-client.js` cloud sync engine.
- **Backend**: Node.js & Express serverless API (`server.js`, `api/index.js`).
- **Database**: MongoDB Atlas via `mongoose` connection pooling.
- **Security**: `bcryptjs` password encryption, `jsonwebtoken` (JWT) authentication, strict input validation.
- **Deployment**: Vercel Serverless (`vercel.json` rewrites and Edge CDN).

---

## 🚀 Beginner-Friendly Setup Guide

Follow these steps to connect your MongoDB Atlas cloud database to your Vercel deployment:

### 1. Create a Free MongoDB Atlas Database
1. Go to [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) and create a free account (or log in).
2. Click **Create a Deployment** and select the **M0 Free** cluster.
3. Choose a cloud provider and region close to you (e.g., AWS / Mumbai or US East), then click **Create**.
4. Set up a **Database User**:
   - Enter a **Username** (e.g., `pipeline_user`).
   - Enter a secure **Password** (e.g., `SecurePass123!`). *Note this down!*
   - Click **Create User**.
5. Set up **Network Access / IP Whitelist**:
   - Go to **Network Access** in the left sidebar.
   - Click **Add IP Address**.
   - Select **Allow Access From Anywhere** (`0.0.0.0/0`) so Vercel's serverless functions can connect.
   - Click **Confirm**.
6. Get your **Connection String**:
   - Go to **Database** in the left sidebar.
   - Click **Connect** on your cluster.
   - Select **Drivers** (Node.js).
   - Copy the connection string. It looks like:
     ```text
     mongodb+srv://pipeline_user:<password>@cluster0.abcde.mongodb.net/?retryWrites=true&w=majority
     ```
   - Replace `<password>` with your actual database user password and specify the database name before the `?` (e.g. `...mongodb.net/pipeline_db?retryWrites=true...`).

---

### 2. Configure Vercel Environment Variables
1. Go to your [Vercel Dashboard](https://vercel.com/dashboard).
2. Click on your project: **`pipline`** (or `pipline-t27l`).
3. Navigate to **Settings** > **Environment Variables**.
4. Add the following two environment variables:
   - **Name**: `MONGODB_URI`  
     **Value**: `mongodb+srv://pipeline_user:yourPassword@cluster0.abcde.mongodb.net/pipeline_db?retryWrites=true&w=majority`  
     *(Ensure Production, Preview, and Development checkboxes are selected)*
   - **Name**: `JWT_SECRET`  
     **Value**: A random secure string (e.g., `my-super-secret-jwt-key-2026`)
5. Click **Save**.

---

### 3. Deploying to Vercel via GitHub
Whenever you push to the `main` branch on GitHub:
```bash
git add .
git commit -m "Upgrade to cloud accounts and MongoDB Atlas sync"
git push origin main
```
Vercel automatically triggers a new deployment with your updated environment variables!

---

## 📋 Multi-Device Verification Checklist

Once deployed, verify synchronization across multiple devices (e.g., your laptop and your mobile phone):

- [ ] **Account Creation**: Open the live site on Device 1, click **☁️ Sign In / Register**, select **New Account**, and register with a username and password.
- [ ] **Badge Status**: Confirm the top-right badge shows your username and a green **"Synced across devices"** indicator.
- [ ] **Add Expenses/Entries**: Add an entry (e.g., `101 - Pipe A - 500`) and verify it appears in Column 1 and updates the Total PIP counter.
- [ ] **Sign In on Device 2**: Open the website on your phone, tablet, or another browser window.
- [ ] **Cloud Retrieval**: Sign in with the exact same account credentials on Device 2. Confirm your entries and columns load immediately!
- [ ] **Live Edit Sync**: Move or edit an entry on Device 1. Within a few seconds, observe Device 2 automatically update with the notification: *"☁️ Data updated from your other device."*
- [ ] **Deleted History**: Delete an item on Device 1, go to **History**, and verify it is logged in the cloud database.
- [ ] **User Isolation**: Log out and create a different account (User 2). Verify that User 2 starts with their own fresh dashboard and cannot view User 1's records.

---

## 🔒 Security Summary

- Password hashes are never stored in plain text (`bcryptjs` with 10 salt rounds).
- Database credentials and secrets are kept strictly server-side in Vercel environment variables.
- All protected API routes require and cryptographically verify the JWT bearer token.
