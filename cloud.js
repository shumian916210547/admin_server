const task = require('./Cloud/Task')
const modules = {
  beforeSave: [],
  afterSave: [],
  beforeDelete: [],
  afterDelete: [],
  ...task
}
Object.keys(modules).forEach(key => {
  modules[key].forEach(item => {
    Parse.Cloud[key](item.class, item.func)
  })
})