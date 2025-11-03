
// touch: categories-fix 2025-11-03T00:50:16

// touch: categories-create-fix 2025-11-03T01:07:27
//
// Case-insensitive duplicate check
      const { rows: dup } = await pool.query(
        'SELECT 1 FROM categories WHERE lower(name) = lower() LIMIT 1', [nm]
      );
      if (dup.length) return res.status(409).json({ error: 'category already exists' });

      // Minimal insert; enabled uses DB default TRUE
      const { rows } = await pool.query(
        'INSERT INTO categories(name) VALUES () RETURNING id, name, enabled, created_at',
        [nm]
      );
      return res.status(201).json(rows[0]);
    } catch (e) {
      console.error('categories create error:', e);
      return res.status(500).json({ error: 'Create failed', code: e.code || null, detail: e.message || String(e) });
    }
  });
} catch (e) {
  console.warn('categories create route not mounted:', e.message);
}

} catch (e) {
  console.warn('public categories route not mounted:', e.message);
}

} else {
      console.error('Boot guard: app is not available');
      process.exit(1);
    }
  }
} catch (e) {
  console.error('Boot guard error:', e);
  process.exit(1);
}

// touch: categories-create-override " + (Get-Date -Format s) + @"
try { require('./routes/categoriesOverride')(app, pool, ensureCategoriesTable, authRole, authOptional); } catch (e) { console.warn('categories override not mounted:', e.message); }
