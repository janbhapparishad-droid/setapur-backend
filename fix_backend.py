with open('src/server.js', 'r', encoding='utf-8') as f:
    code = f.read()

s1 = \"if (typeof body.donorName === 'string') { fields.push(donor_name = $); vals.push(body.donorName.trim()); }\"
r1 = \"if (typeof body.donorName === 'string') { fields.push(donor_name = $); vals.push(body.donorName.trim()); }\n      if (typeof body.donorUsername === 'string') { fields.push(donor_username = $); vals.push(body.donorUsername.trim()); }\"

if s1 in code:
    code = code.replace(s1, r1)
    with open('src/server.js', 'w', encoding='utf-8') as f:
        f.write(code)
    print("Backend updated!")
else:
    print("Could not find string in backend!")
