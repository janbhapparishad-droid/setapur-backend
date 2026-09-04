import re

with open('src/server.js', 'r', encoding='utf-8') as f:
    code = f.read()

s1 = """    const { rows: eventsCfg } = await pool.query(
      'SELECT id, folder_id, name, show_donation_detail, show_expense_detail FROM analytics_events WHERE enabled=true ORDER BY order_index ASC, id ASC'
    );"""
r1 = """    const { rows: eventsCfg } = await pool.query(
      'SELECT id, folder_id, name, show_donation_detail, show_expense_detail FROM analytics_events WHERE enabled=true ORDER BY order_index ASC, id ASC'
    );
    const { rows: categories } = await pool.query(
      'SELECT id, name FROM categories WHERE enabled=true ORDER BY order_index ASC, id ASC'
    );"""

code = code.replace(s1, r1)

s2 = """      return {
        folderName: folder.name,
        events: folderEvents
      };
    });

    res.json(response);"""
r2 = """      return {
        folderName: folder.name,
        events: folderEvents
      };
    });

    // Append unmapped categories
    const mappedEventNames = new Set(eventsCfg.map(e => norm(e.name)));
    const unmappedCategories = categories.filter(c => !mappedEventNames.has(norm(c.name)));

    if (unmappedCategories.length > 0) {
      const otherEvents = {};
      for (const cat of unmappedCategories) {
        const catKey = norm(cat.name);
        const data = dataMap.get(catKey) || { donationTotal: 0, expenseTotal: 0, donations: [] };
        otherEvents[cat.name] = {
          donationTotal: data.donationTotal,
          expenseTotal: data.expenseTotal,
          balance: data.donationTotal - data.expenseTotal,
          donations: data.donations,
          config: { showDonationDetail: true, showExpenseDetail: true }
        };
      }
      let otherFolder = response.find(f => f.folderName === 'Other Events' || f.folderName === 'Other');
      if (otherFolder) {
        Object.assign(otherFolder.events, otherEvents);
      } else {
        response.push({ folderName: 'Other Events', events: otherEvents });
      }
    }

    res.json(response);"""

code = code.replace(s2, r2)

with open('src/server.js', 'w', encoding='utf-8') as f:
    f.write(code)

print("SUCCESS")
