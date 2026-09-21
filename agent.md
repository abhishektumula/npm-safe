
Hey, we are going to work together on this project so i just want to introduce myself. Hi my name is 'A'. I like building stuff and make money out of that. and i like JetBrainsMono and GeistMono nerd fonts.(i am just saying)

# npm-safe
- npm safe project helps any user to view inforamation about the packages that they are installing right there in the CLI. 
- this helps to install the correct package and not some package that has some kind of worms or zero days. 

# tech stack 
- This project is initialized in `bun`
- keep this package as minimal as possible.

# rules 
- no UI is required for this package.
- before writing up any code, do search the internet and then proceed to writing the code.
- Don't write bun of ai slop code. 
- keep different files for differnet functions or components. 
- keep the latency as minimal as possible
- it should looks cool and crazy showing details with colors. (ignore bold and itallic)
- if you can use a different font while showing data (use JetBrainsMono Nerd Font)


# what to show 
- Name of the package: name
- author/ creator: A 
- github repo: https://github.com/express (example)
- direct dependencies: 69 
- transitive dependencies: 67 
- total dependencies: 136
- security health check: 80/100

# inforamation source
- for packages details: https://www.npmjs.com/package/{package_name}
- for security health: https://security.snyk.io/package/npm/{package_name}

-try fetching the data from the those url and show up the data before installing.
- for security health you need to scrape the data. It says something like `package health score` with some other fields like `security`, `popularity`, `maintainace` and `community`

# workflow 
- user gives commands like `npm-sage install express`
- fetch all the data about express
- show it with colorful syntax 
- then ask for [y/N] 
- if y install the package with whatever the package manager is being used. (pnpm, bun, npm, yarn, brew)
- make sure it takes multiple packages to install command and show the details. 
- if more than 2 packages being installed from one command, then cut out the information like github repo url, and remove both direct and transitive dependencies. instead show total dependencies like 136(69d, 67t)

# flags
- use -a flag to show all the details. (like direct depencencies packages names ..etc)
- suggest more useful flags.
