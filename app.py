import sys
import os
import webbrowser
import threading
import time
import sqlite3
import base64
import json
from pathlib import Path
from flask import Flask, render_template, request, jsonify, g
from flask_cors import CORS
from flask_socketio import SocketIO

app = Flask(__name__)
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

# ---------- Путь к БД ----------
def get_db_path():
    if getattr(sys, 'frozen', False):
        return os.path.join(os.path.dirname(sys.executable), 'bookmarks.db')
    return 'bookmarks.db'

def get_db():
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")  # 👈 ВКЛЮЧАЕМ ПОДДЕРЖКУ ВНЕШНИХ КЛЮЧЕЙ
    return conn

@app.teardown_appcontext
def teardown_db(exception):
    db = getattr(g, '_database', None)
    if db is not None:
        db.close()

# ---------- Инициализация БД ----------
def init_db():
    db = get_db()
    db.executescript('''
        CREATE TABLE IF NOT EXISTS tabs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            position INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS cards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tab_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            url TEXT NOT NULL,
            image TEXT,
            position INTEGER NOT NULL,
            FOREIGN KEY(tab_id) REFERENCES tabs(id) ON DELETE CASCADE
        );
    ''')
    cursor = db.execute("SELECT COUNT(*) FROM tabs")
    if cursor.fetchone()[0] == 0:
        db.execute("INSERT INTO tabs (name, position) VALUES (?, ?)", ("Вкладка", 1))
    db.commit()
    db.close()

# ---------- Маршруты ----------
@app.route('/')
def index():
    return render_template('index.html')

# ---------- API: вкладки ----------
@app.route('/api/tabs', methods=['GET'])
def get_tabs():
    db = get_db()
    tabs = db.execute("SELECT id, name, position FROM tabs ORDER BY position").fetchall()
    db.close()
    return jsonify([dict(tab) for tab in tabs])

@app.route('/api/tabs', methods=['POST'])
def create_tab():
    data = request.json
    name = data.get('name', '').strip()
    if not name:
        return jsonify({'error': 'Название вкладки не может быть пустым'}), 400
    db = get_db()
    max_pos = db.execute("SELECT COALESCE(MAX(position), 0) + 1 FROM tabs").fetchone()[0]
    cur = db.execute("INSERT INTO tabs (name, position) VALUES (?, ?)", (name, max_pos))
    db.commit()
    new_id = cur.lastrowid
    db.close()
    return jsonify({'id': new_id, 'name': name, 'position': max_pos})

@app.route('/api/tabs/<int:tab_id>', methods=['PUT'])
def rename_tab(tab_id):
    data = request.json
    new_name = data.get('name', '').strip()
    if not new_name:
        return jsonify({'error': 'Название не может быть пустым'}), 400
    db = get_db()
    db.execute("UPDATE tabs SET name = ? WHERE id = ?", (new_name, tab_id))
    db.commit()
    db.close()
    return jsonify({'message': 'ok'})

@app.route('/api/tabs/<int:tab_id>', methods=['DELETE'])
def delete_tab(tab_id):
    db = get_db()
    count = db.execute("SELECT COUNT(*) FROM tabs").fetchone()[0]
    if count <= 1:
        db.close()
        return jsonify({'error': 'Нельзя удалить последнюю вкладку'}), 400
    db.execute("DELETE FROM tabs WHERE id = ?", (tab_id,))
    db.commit()
    db.close()
    return jsonify({'message': 'ok'})

@app.route('/api/tabs/reorder', methods=['PATCH'])
def reorder_tabs():
    data = request.json
    if not isinstance(data, list):
        return jsonify({'error': 'Неверный формат'}), 400
    db = get_db()
    for item in data:
        db.execute("UPDATE tabs SET position = ? WHERE id = ?", (item['position'], item['id']))
    db.commit()
    db.close()
    return jsonify({'message': 'ok'})

# ---------- API: карточки ----------
@app.route('/api/tabs/<int:tab_id>/cards', methods=['GET'])
def get_cards(tab_id):
    db = get_db()
    cards = db.execute(
        "SELECT id, tab_id, title, description, url, image, position FROM cards WHERE tab_id = ? ORDER BY position",
        (tab_id,)
    ).fetchall()
    db.close()
    return jsonify([dict(card) for card in cards])

@app.route('/api/cards', methods=['POST'])
def create_card():
    data = request.json
    tab_id = data.get('tab_id')
    title = data.get('title', '').strip()
    url = data.get('url', '').strip()
    description = data.get('description', 'Без описания')
    image = data.get('image', '')
    if not title or not url:
        return jsonify({'error': 'Название и ссылка обязательны'}), 400
    db = get_db()
    max_pos = db.execute("SELECT COALESCE(MAX(position), 0) + 1 FROM cards WHERE tab_id = ?", (tab_id,)).fetchone()[0]
    cur = db.execute(
        "INSERT INTO cards (tab_id, title, description, url, image, position) VALUES (?, ?, ?, ?, ?, ?)",
        (tab_id, title, description, url, image, max_pos)
    )
    db.commit()
    new_id = cur.lastrowid
    db.close()
    return jsonify({'id': new_id, 'tab_id': tab_id, 'title': title, 'description': description,
                    'url': url, 'image': image, 'position': max_pos})

@app.route('/api/cards/<int:card_id>', methods=['PUT'])
def update_card(card_id):
    data = request.json
    title = data.get('title', '').strip()
    url = data.get('url', '').strip()
    description = data.get('description', '')
    image = data.get('image', '')
    if not title or not url:
        return jsonify({'error': 'Название и ссылка обязательны'}), 400
    db = get_db()
    db.execute(
        "UPDATE cards SET title = ?, description = ?, url = ?, image = ? WHERE id = ?",
        (title, description, url, image, card_id)
    )
    db.commit()
    db.close()
    return jsonify({'message': 'ok'})

@app.route('/api/cards/<int:card_id>', methods=['DELETE'])
def delete_card(card_id):
    db = get_db()
    db.execute("DELETE FROM cards WHERE id = ?", (card_id,))
    db.commit()
    db.close()
    return jsonify({'message': 'ok'})

@app.route('/api/cards/reorder', methods=['PATCH'])
def reorder_cards():
    data = request.json
    tab_id = data.get('tab_id')
    order = data.get('order')
    if not tab_id or not isinstance(order, list):
        return jsonify({'error': 'Неверные данные'}), 400
    db = get_db()
    for item in order:
        db.execute("UPDATE cards SET position = ? WHERE id = ? AND tab_id = ?", (item['position'], item['id'], tab_id))
    db.commit()
    db.close()
    return jsonify({'message': 'ok'})

@app.route('/api/cards/move', methods=['PATCH'])
def move_card():
    data = request.json
    card_id = data.get('card_id')
    to_tab_id = data.get('to_tab_id')
    if not card_id or not to_tab_id:
        return jsonify({'error': 'Недостаточно данных'}), 400
    db = get_db()
    card = db.execute("SELECT * FROM cards WHERE id = ?", (card_id,)).fetchone()
    if not card:
        db.close()
        return jsonify({'error': 'Карточка не найдена'}), 404
    db.execute("DELETE FROM cards WHERE id = ?", (card_id,))
    max_pos = db.execute("SELECT COALESCE(MAX(position), 0) + 1 FROM cards WHERE tab_id = ?", (to_tab_id,)).fetchone()[0]
    db.execute(
        "INSERT INTO cards (tab_id, title, description, url, image, position) VALUES (?, ?, ?, ?, ?, ?)",
        (to_tab_id, card['title'], card['description'], card['url'], card['image'], max_pos)
    )
    db.commit()
    db.close()
    return jsonify({'message': 'ok'})

# ---------- Загрузка картинки (base64) ----------
@app.route('/api/upload_image', methods=['POST'])
def upload_image():
    if 'image' not in request.files:
        return jsonify({'error': 'Файл не передан'}), 400
    file = request.files['image']
    if file.filename == '':
        return jsonify({'error': 'Файл не выбран'}), 400
    data = file.read()
    b64 = base64.b64encode(data).decode('utf-8')
    mime = file.mimetype
    image_data_url = f"data:{mime};base64,{b64}"
    return jsonify({'url': image_data_url})

# ---------- Импорт из Chrome ----------
@app.route('/api/import_chrome', methods=['POST'])
def import_chrome():
    if sys.platform == 'win32':
        base = Path(os.environ.get('LOCALAPPDATA', '')) / 'Google' / 'Chrome' / 'User Data'
    elif sys.platform == 'darwin':
        base = Path.home() / 'Library' / 'Application Support' / 'Google' / 'Chrome'
    else:
        base = Path.home() / '.config' / 'google-chrome'

    bookmarks_file = None
    for profile in ['Default'] + [f'Profile {i}' for i in range(1, 10)]:
        candidate = base / profile / 'Bookmarks'
        if candidate.exists():
            bookmarks_file = candidate
            break
        candidate_bak = base / profile / 'Bookmarks.bak'
        if candidate_bak.exists():
            bookmarks_file = candidate_bak
            break

    if not bookmarks_file or not bookmarks_file.exists():
        return jsonify({'error': 'Не найден файл закладок Chrome'}), 404

    try:
        with open(bookmarks_file, 'r', encoding='utf-8') as f:
            chrome_json = json.load(f)
    except Exception as e:
        return jsonify({'error': f'Ошибка чтения: {str(e)}'}), 500

    def extract_bookmarks(node, path=''):
        items = []
        if 'children' in node:
            for child in node['children']:
                if child.get('type') == 'url':
                    items.append({
                        'title': child.get('name', 'Без названия'),
                        'url': child.get('url', ''),
                        'description': child.get('meta_info', {}).get('description', ''),
                    })
                elif child.get('type') == 'folder':
                    items.extend(extract_bookmarks(child, path + '/' + child.get('name', '')))
        return items

    roots = chrome_json.get('roots', {})
    all_bookmarks = []
    for folder in roots.values():
        all_bookmarks.extend(extract_bookmarks(folder))

    if not all_bookmarks:
        return jsonify({'error': 'Не найдено ни одной закладки'}), 404

    db = get_db()
    tab_name = "Из Chrome"
    tab_cursor = db.execute("SELECT id FROM tabs WHERE name = ?", (tab_name,))
    existing = tab_cursor.fetchone()
    if existing:
        tab_id = existing['id']
        db.execute("DELETE FROM cards WHERE tab_id = ?", (tab_id,))
    else:
        max_pos = db.execute("SELECT COALESCE(MAX(position), 0) + 1 FROM tabs").fetchone()[0]
        cur = db.execute("INSERT INTO tabs (name, position) VALUES (?, ?)", (tab_name, max_pos))
        db.commit()
        tab_id = cur.lastrowid

    for idx, bm in enumerate(all_bookmarks):
        db.execute(
            "INSERT INTO cards (tab_id, title, description, url, image, position) VALUES (?, ?, ?, ?, ?, ?)",
            (tab_id, bm['title'], bm['description'], bm['url'], '', idx)
        )
    db.commit()
    db.close()
    return jsonify({'message': f'Импортировано {len(all_bookmarks)} закладок в вкладку "{tab_name}"', 'tab_id': tab_id})

# ---------- Экспорт / Импорт JSON ----------
@app.route('/api/export', methods=['GET'])
def export_data():
    db = get_db()
    tabs = db.execute("SELECT id, name, position FROM tabs ORDER BY position").fetchall()
    all_cards = {}
    for tab in tabs:
        cards = db.execute(
            "SELECT id, tab_id, title, description, url, image, position FROM cards WHERE tab_id = ? ORDER BY position",
            (tab['id'],)).fetchall()
        all_cards[tab['id']] = [dict(card) for card in cards]
    db.close()
    return jsonify({
        'tabs': [dict(tab) for tab in tabs],
        'cards': all_cards
    })

@app.route('/api/import', methods=['POST'])
def import_data():
    data = request.json
    if not data or 'tabs' not in data or 'cards' not in data:
        return jsonify({'error': 'Неверный формат данных'}), 400
    db = get_db()
    try:
        db.execute("BEGIN")
        db.execute("DELETE FROM cards")
        db.execute("DELETE FROM tabs")
        imported_tabs = data['tabs']
        if imported_tabs and 'position' not in imported_tabs[0]:
            for idx, tab in enumerate(imported_tabs, start=1):
                tab['position'] = idx
        for tab in imported_tabs:
            db.execute("INSERT INTO tabs (id, name, position) VALUES (?, ?, ?)",
                       (tab['id'], tab['name'], tab['position']))
        for tab_id_str, cards_list in data['cards'].items():
            tab_id_int = int(tab_id_str)
            for card in cards_list:
                description = card.get('description', '')
                if not description and 'desc' in card:
                    description = card['desc']
                if not description:
                    description = 'Без описания'
                image = card.get('image', '')
                position = card.get('position', 0)
                db.execute(
                    "INSERT INTO cards (id, tab_id, title, description, url, image, position) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (card['id'], tab_id_int, card['title'], description, card['url'], image, position)
                )
        db.execute("COMMIT")
        db.close()
        return jsonify({'message': 'Импорт успешно выполнен'})
    except Exception as e:
        db.execute("ROLLBACK")
        db.close()
        return jsonify({'error': f'Ошибка импорта: {str(e)}'}), 500

# ---------- WebSocket ----------
connected_clients = 0

@socketio.on('connect')
def handle_connect():
    global connected_clients
    connected_clients += 1
    print(f"✅ Клиент подключился. Активных: {connected_clients}")


@socketio.on('disconnect')
def handle_disconnect():
    global connected_clients
    connected_clients -= 1
    print(f"❌ Клиент отключился. Осталось: {connected_clients}")

    if connected_clients <= 0:
        # Даем чуть больше времени на перезагрузку страницы (1.5 сек вместо 0.5)
        time.sleep(1.5)

        # 👈 ГЛАВНОЕ: Проверяем СНОВА после паузы!
        if connected_clients <= 0:
            print("\n🛑 Последняя вкладка закрыта. Завершаю приложение...")
            os._exit(0)
        else:
            print("🔄 Страница просто перезагрузилась. Продолжаем работу!")

# ---------- Ping (дополнительный) ----------
@app.route('/api/ping', methods=['POST'])
def ping():
    return jsonify({'status': 'ok'})

# ---------- Запуск ----------
if __name__ == '__main__':
    init_db()

    if not os.environ.get('WERKZEUG_RUN_MAIN'):
        def open_browser():
            time.sleep(1.5)
            webbrowser.open('http://localhost:5000')
        threading.Thread(target=open_browser, daemon=True).start()

    print("🚀 Приложение запущено. Будет закрываться при закрытии последней вкладки.")
    socketio.run(app, host='0.0.0.0', port=5000, debug=False, allow_unsafe_werkzeug=True)