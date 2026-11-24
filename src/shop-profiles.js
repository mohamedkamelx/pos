'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

class ShopProfiles {
  constructor(root) {
    this.root = root;
    this.file = path.join(root, 'shop-profiles.json');
    try {
      this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.state = { active: 'original', shops: [{ id: 'original', name: 'Local shop' }] };
    }
    this.directory(this.state.active);
  }
  directory(id) {
    if (!this.state.shops.some(s => s.id === id)) throw new Error('Unknown shop.');
    if (id === 'original') return this.root;
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)) throw new Error('Invalid shop profile.');
    return path.join(this.root, 'shop-profiles', id);
  }
  save(state) {
    const temporary = this.file + '.' + randomUUID();
    fs.writeFileSync(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, this.file);
    this.state = state;
  }
  add() {
    const id = randomUUID();
    this.save({ ...this.state, shops: [...this.state.shops, { id, name: 'New shop' }] });
    return id;
  }
  rename(name) {
    if (typeof name !== 'string' || !name.trim()) return;
    const active = this.state.shops.find(s => s.id === this.state.active);
    if (active.name !== name) this.save({ ...this.state, shops: this.state.shops.map(s => s === active ? { ...s, name } : s) });
  }
  activate(id) {
    this.directory(id);
    this.save({ ...this.state, active: id });
  }
}
module.exports = { ShopProfiles };
