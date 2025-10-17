Telegram Gym Access Bot
This is a Telegram bot for automated membership and attendance management in a gym or group training environment, supporting paid subscription, admin operations, and participant tracking. All payments, sessions, and users are managed via a local SQLite database.

Features
User registration and profile management: users register with name, room, faculty, etc.

Subscription plans: supports several access plans (A, B, UNLIMITED), discounts for long-term payments, and faculty-based access rules.

Payment system: payment requests, approval workflow, manual and photo receipt uploads, unique payment codes, and discount calculation.

Attendance tracking: session management with captain role, join/leave actions.

Admin and Superadmin roles: manual grants, reject/block users, subscription management, attendance history/logs, and user blocking/unblocking.

Status and notification posts: bot can send status summaries to group chat and notify captains/watchers of activity.

Technologies Used
Node.js & Telegraf (Telegram bot API)

SQLite via better-sqlite3

Environment config: via .env

date-fns-tz: for time zone formatting (Europe/Kyiv)

Quickstart
Clone the repo and install dependencies:

bash
git clone https://github.com/yourusername/yourbotrepo.git
cd yourbotrepo
npm install
Create a .env file with the required configuration:

text
BOTTOKEN=your_telegram_bot_token
GROUPCHATID=your_group_chat_id
PAYMENTDETAILS='Your payment details and IBAN'
TZ=Europe/Kyiv
ADMINS=comma_separated_tg_user_ids
SUPERADMINS=comma_separated_tg_user_ids
WATCHERALLOWIDS=comma_separated_tg_user_ids
WATCHCHATIDS=comma_separated_tg_chat_ids
Start the bot:

bash
node index.js
Database Structure
See db.js for table definitions (users, sessions, visits, payments, subscriptions, etc). On first launch, required tables are created automatically.

Key Files
index.js — main entry point & business logic

db.js — SQLite database setup & migrations

subscriptions.js — subscription management logic

statusPost.js — status message logic for group posting

Usage
Users interact with the bot to register, pay for subscriptions, and join/leave sessions.

Admins and superadmins have extra commands via Telegram to manage users, subscriptions, and logs.

Bot posts group status messages and tracks gym visit statistics.
