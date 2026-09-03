import re

with open('src/server.js', 'r', encoding='utf-8') as f:
    code = f.read()

replacement = r'''
    await pool.query('ALTER TABLE calendar_events ADD CONSTRAINT unique_title_date UNIQUE (title, event_date) ').catch(e=>null);

    const festivals = [
      { title: 'Makar Sankranti', date: '2025-01-14', desc: 'Festival of harvest and Sun transition' },
      { title: 'Vasant Panchami', date: '2025-02-02', desc: 'Dedicated to Goddess Saraswati' },
      { title: 'Maha Shivaratri', date: '2025-02-26', desc: 'Auspicious day dedicated to Lord Shiva' },
      { title: 'Holi', date: '2025-03-14', desc: 'Festival of Colors' },
      { title: 'Chaitra Navratri Starts', date: '2025-03-30', desc: 'Beginning of Chaitra Navratri' },
      { title: 'Ram Navami', date: '2025-04-06', desc: 'Birth of Lord Rama' },
      { title: 'Hanuman Jayanti', date: '2025-04-12', desc: 'Birth of Lord Hanuman' },
      { title: 'Akshaya Tritiya', date: '2025-04-30', desc: 'Auspicious day for new beginnings' },
      { title: 'Nirjala Ekadashi', date: '2025-06-06', desc: 'Strict fasting Ekadashi' },
      { title: 'Guru Purnima', date: '2025-07-10', desc: 'Dedicated to spiritual teachers' },
      { title: 'Nag Panchami', date: '2025-07-29', desc: 'Traditional worship of snakes' },
      { title: 'Raksha Bandhan', date: '2025-08-09', desc: 'Bond of protection between brother and sister' },
      { title: 'Krishna Janmashtami', date: '2025-08-16', desc: 'Birth of Lord Krishna' },
      { title: 'Ganesh Chaturthi', date: '2025-08-27', desc: 'Arrival of Lord Ganesha' },
      { title: 'Radhashtami', date: '2025-09-04', desc: 'Birth of Goddess Radha' },
      { title: 'Navratri Starts', date: '2025-09-22', desc: 'Beginning of Sharad Navratri' },
      { title: 'Durga Ashtami', date: '2025-09-30', desc: 'Maha Ashtami Puja' },
      { title: 'Dussehra', date: '2025-10-02', desc: 'Victory of good over evil' },
      { title: 'Karwa Chauth', date: '2025-10-10', desc: 'Fasting for longevity of husbands' },
      { title: 'Dhanteras', date: '2025-10-18', desc: 'First day of Diwali festival' },
      { title: 'Diwali', date: '2025-10-20', desc: 'Festival of Lights' },
      { title: 'Govardhan Puja', date: '2025-10-22', desc: 'Worship of Mount Govardhan' },
      { title: 'Bhai Dooj', date: '2025-10-23', desc: 'Festival celebrating brother-sister bond' },
      { title: 'Chhath Puja', date: '2025-10-26', desc: 'Ancient Hindu festival dedicated to Surya' },
      { title: 'Tulsi Vivah', date: '2025-11-01', desc: 'Ceremonial marriage of Tulsi' },
      { title: 'Gita Jayanti', date: '2025-11-30', desc: 'Birth of Srimad Bhagavad Gita' },
      { title: 'Makar Sankranti', date: '2026-01-14', desc: 'Festival of harvest' },
      { title: 'Vasant Panchami', date: '2026-01-23', desc: 'Dedicated to Goddess Saraswati' },
      { title: 'Maha Shivaratri', date: '2026-02-15', desc: 'Auspicious day dedicated to Lord Shiva' },
      { title: 'Holi', date: '2026-03-03', desc: 'Festival of Colors' },
      { title: 'Chaitra Navratri Starts', date: '2026-03-19', desc: 'Beginning of Chaitra Navratri' },
      { title: 'Ram Navami', date: '2026-03-27', desc: 'Birth of Lord Rama' },
      { title: 'Hanuman Jayanti', date: '2026-04-02', desc: 'Birth of Lord Hanuman' },
      { title: 'Akshaya Tritiya', date: '2026-04-19', desc: 'Auspicious day' },
      { title: 'Nirjala Ekadashi', date: '2026-05-27', desc: 'Strict fasting Ekadashi' },
      { title: 'Guru Purnima', date: '2026-06-29', desc: 'Dedicated to spiritual teachers' },
      { title: 'Nag Panchami', date: '2026-07-18', desc: 'Traditional worship' },
      { title: 'Raksha Bandhan', date: '2026-08-28', desc: 'Bond of protection' },
      { title: 'Krishna Janmashtami', date: '2026-09-04', desc: 'Birth of Lord Krishna' },
      { title: 'Ganesh Chaturthi', date: '2026-09-14', desc: 'Arrival of Lord Ganesha' },
      { title: 'Navratri Starts', date: '2026-10-10', desc: 'Beginning of Sharad Navratri' },
      { title: 'Dussehra', date: '2026-10-19', desc: 'Victory of good over evil' },
      { title: 'Karwa Chauth', date: '2026-10-29', desc: 'Fasting for longevity of husbands' },
      { title: 'Dhanteras', date: '2026-11-06', desc: 'First day of Diwali' },
      { title: 'Diwali', date: '2026-11-08', desc: 'Festival of Lights' },
      { title: 'Bhai Dooj', date: '2026-11-10', desc: 'Brother-sister bond' },
      { title: 'Chhath Puja', date: '2026-11-14', desc: 'Sun worship' }
    ];
    for (const f of festivals) {
      await pool.query('INSERT INTO calendar_events (title, event_date, description) VALUES (, , ) ON CONFLICT DO NOTHING', [f.title, f.date, f.desc]).catch(e=>null);
    }
'''

new_code = re.sub(r'    const \{ rows \} = await pool\.query\(\'SELECT count\(\*\) FROM calendar_events\'\);[\s\S]*?      \}', replacement, code)
with open('src/server.js', 'w', encoding='utf-8') as f:
    f.write(new_code)

print("Patched!")
