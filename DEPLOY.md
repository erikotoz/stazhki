# Фаза 3 — выложить в интернет (Render + Supabase), 24/7

Итог: постоянная ссылка вида `https://stazhki-v-raschete.onrender.com`, работает всегда,
твой Mac можно выключать. Данные — в облачной базе Supabase (Postgres), бесплатно.

Схема: **браузеры друзей → наш Python-сервер на Render → база Supabase Postgres.**

---

## Шаг 1. Получить строку подключения к Supabase

1. Зайди в свой проект на [supabase.com](https://supabase.com).
2. Вверху нажми кнопку **Connect** (или Project Settings → Database).
3. Найди раздел **Connection string → выбери `Session pooler`** (порт 5432) и формат **URI**.
   Строка выглядит так:
   ```
   postgresql://postgres.abcdefgh:[YOUR-PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:5432/postgres
   ```
4. Замени `[YOUR-PASSWORD]` на пароль базы (тот, что задавал при создании проекта;
   если забыл — там же можно сбросить: Database → Reset database password).
5. В конец допиши `?sslmode=require`. Должно получиться:
   ```
   postgresql://postgres.abcdefgh:ТВОЙПАРОЛЬ@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require
   ```
   Это и есть **DATABASE_URL**. Таблицы создадутся сами при первом запуске.

> ⚠️ Эту строку (в ней пароль) никуда не публикуй и не коммить в git. Её вставим
> только в настройки Render как секретную переменную.

---

## Шаг 2. Залить код на GitHub

Я уже сделал git-репозиторий локально. Осталось создать пустой репозиторий на GitHub
и запушить. Самый простой путь:

1. Создай новый **приватный** репозиторий на [github.com/new](https://github.com/new)
   (имя любое, например `stazhki`). Не добавляй README/`.gitignore` — он уже есть.
2. В терминале из папки проекта:
   ```bash
   cd ~/pay-app
   git remote add origin https://github.com/ТВОЙ_ЛОГИН/stazhki.git
   git branch -M main
   git push -u origin main
   ```
   (GitHub попросит логин — используй Personal Access Token вместо пароля,
   или установи `gh` и `gh auth login`.)

---

## Шаг 3. Развернуть на Render

1. Зарегистрируйся на [render.com](https://render.com) (можно через GitHub) — бесплатно.
2. Нажми **New +** → **Blueprint** и выбери свой репозиторий. Render прочитает `render.yaml`
   и сам поймёт, как собирать (`pip install -r requirements.txt`) и запускать (`python server.py`).
   *(Если Blueprint не подхватился — выбери **New + → Web Service**, тот же репозиторий,
   Build: `pip install -r requirements.txt`, Start: `python server.py`.)*
3. В настройках сервиса открой **Environment** и добавь переменную:
   - **Key:** `DATABASE_URL`
   - **Value:** строка из Шага 1
4. Нажми **Create / Deploy**. Первый деплой — пара минут. Когда статус станет **Live**,
   откроется адрес вида `https://….onrender.com` — это и есть ваша ссылка для друзей.

Готово. Каждый заходит по ссылке и регистрируется (база в облаке новая, пустая).

---

## Что важно знать

- **Бесплатный Render «засыпает»** после ~15 минут без запросов. Первый заход после простоя
  просыпается ~30–60 секунд — это нормально. (Потом отвечает быстро.)
- **Локальная разработка не меняется**: `python3 server.py` по-прежнему запускает версию на
  SQLite (без всякого Postgres) — удобно тестировать у себя, не трогая боевую базу.
- **Проверить Postgres локально** (по желанию, перед деплоем):
  ```bash
  pip3 install 'psycopg[binary]'
  DATABASE_URL="строка-из-шага-1" python3 server.py
  ```
  Если поднялось без ошибок и в Supabase → Table editor появились таблицы — всё ок.
- Хочешь свой домен (например `raschet.ru`) — Render позволяет подключить его в настройках,
  это отдельный небольшой шаг.
